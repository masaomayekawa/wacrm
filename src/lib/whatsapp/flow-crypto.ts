import crypto from 'node:crypto'

/**
 * Crypto for the WhatsApp Flows `data_exchange` endpoint.
 *
 * Meta encrypts every request to a Flow's business endpoint with a
 * one-time AES-128-GCM key, and encrypts that key with the business's
 * RSA public key (RSA-OAEP / SHA-256). Our endpoint reverses it, then
 * encrypts the response with the SAME AES key but a bit-flipped IV.
 *
 * This mirrors Meta's official reference implementation verbatim so
 * the wire format can't drift:
 *   https://github.com/WhatsApp/WhatsApp-Flows-Tools
 *     → examples/endpoint/nodejs/basic/src/encryption.js
 *
 * DISTINCT from `src/lib/whatsapp/encryption.ts` — that module is the
 * AES-256-GCM helper for encrypting secrets AT REST in our DB. This
 * module is the on-the-wire protocol Meta dictates for Flows.
 *
 * Node runtime only: RSA-OAEP + AES-GCM need Node's `crypto`, so any
 * route importing this must run on the Node runtime (not Edge).
 */

/**
 * Thrown when the RSA private-key decryption of the AES key fails.
 * Meta's contract: respond HTTP 421 so the client refreshes the
 * public key it has on file and retries.
 */
export class FlowEndpointError extends Error {
  readonly statusCode: number
  constructor(statusCode: number, message: string) {
    super(message)
    this.name = 'FlowEndpointError'
    this.statusCode = statusCode
  }
}

/** The three base64 fields Meta POSTs to a Flow endpoint. */
export interface EncryptedFlowRequest {
  encrypted_flow_data?: string
  encrypted_aes_key?: string
  initial_vector?: string
}

/** The decrypted request plus the key material needed to encrypt the reply. */
export interface DecryptedFlowRequest {
  decryptedBody: FlowRequestBody
  aesKeyBuffer: Buffer
  initialVectorBuffer: Buffer
}

/**
 * The decrypted payload shape. `action` drives dispatch:
 *   - `ping`          — Meta's health check (must answer {data:{status:'active'}})
 *   - `INIT`          — flow opened, first screen
 *   - `data_exchange` — a screen submitted; return the next screen
 *   - `BACK`          — user navigated back
 */
export interface FlowRequestBody {
  version: string
  action: 'ping' | 'INIT' | 'data_exchange' | 'BACK' | string
  screen?: string
  data?: Record<string, unknown>
  flow_token?: string
}

const AES_AUTH_TAG_LENGTH = 16

/**
 * Decrypt an incoming Flow endpoint request.
 *
 * @param body      the parsed JSON `{ encrypted_aes_key, encrypted_flow_data, initial_vector }`
 * @param privatePem the account's RSA private key (PEM, already decrypted from at-rest storage)
 * @throws FlowEndpointError(421) if the RSA step fails (Meta then refreshes the key)
 */
export function decryptFlowRequest(
  body: EncryptedFlowRequest,
  privatePem: string,
): DecryptedFlowRequest {
  const { encrypted_aes_key, encrypted_flow_data, initial_vector } = body
  if (!encrypted_aes_key || !encrypted_flow_data || !initial_vector) {
    throw new FlowEndpointError(
      400,
      'Missing encrypted_aes_key, encrypted_flow_data, or initial_vector.',
    )
  }

  const privateKey = crypto.createPrivateKey({ key: privatePem })

  let aesKeyBuffer: Buffer
  try {
    aesKeyBuffer = crypto.privateDecrypt(
      {
        key: privateKey,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256',
      },
      Buffer.from(encrypted_aes_key, 'base64'),
    )
  } catch (error) {
    // 421 → Meta re-fetches our public key and retries. This is the
    // expected path if the stored key and Meta's registered key drift.
    console.error('[flow-crypto] RSA decrypt of AES key failed:', error)
    throw new FlowEndpointError(
      421,
      'Failed to decrypt the request. Verify the registered public key.',
    )
  }

  const flowDataBuffer = Buffer.from(encrypted_flow_data, 'base64')
  const initialVectorBuffer = Buffer.from(initial_vector, 'base64')

  // GCM auth tag is appended as the trailing 16 bytes of the ciphertext.
  const cipherText = flowDataBuffer.subarray(0, -AES_AUTH_TAG_LENGTH)
  const authTag = flowDataBuffer.subarray(-AES_AUTH_TAG_LENGTH)

  const decipher = crypto.createDecipheriv(
    'aes-128-gcm',
    aesKeyBuffer,
    initialVectorBuffer,
  )
  decipher.setAuthTag(authTag)

  const decryptedJson = Buffer.concat([
    decipher.update(cipherText),
    decipher.final(),
  ]).toString('utf-8')

  return {
    decryptedBody: JSON.parse(decryptedJson) as FlowRequestBody,
    aesKeyBuffer,
    initialVectorBuffer,
  }
}

/**
 * Encrypt a response for the Flow endpoint.
 *
 * Uses the SAME AES key from the request, but with the IV bit-flipped
 * (bitwise NOT of every byte) — Meta's spec, not a choice. Output is a
 * base64 string returned as `text/plain` (NOT JSON).
 */
export function encryptFlowResponse(
  response: unknown,
  aesKeyBuffer: Buffer,
  initialVectorBuffer: Buffer,
): string {
  const flippedIv = Buffer.from(
    initialVectorBuffer.map((byte) => ~byte),
  )

  const cipher = crypto.createCipheriv('aes-128-gcm', aesKeyBuffer, flippedIv)
  return Buffer.concat([
    cipher.update(JSON.stringify(response), 'utf-8'),
    cipher.final(),
    cipher.getAuthTag(),
  ]).toString('base64')
}

/**
 * Generate a fresh RSA-2048 key pair for a business's Flow endpoint.
 * Public key (SPKI PEM) is uploaded to Meta; private key (PKCS8 PEM)
 * is stored encrypted at rest. No passphrase — the at-rest AES-256-GCM
 * layer is our confidentiality boundary.
 */
export function generateFlowKeyPair(): {
  publicKeyPem: string
  privateKeyPem: string
} {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
  return { publicKeyPem: publicKey, privateKeyPem: privateKey }
}
