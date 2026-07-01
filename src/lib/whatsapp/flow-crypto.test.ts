import crypto from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  decryptFlowRequest,
  encryptFlowResponse,
  generateFlowKeyPair,
  FlowEndpointError,
  type FlowRequestBody,
} from './flow-crypto'

/**
 * These tests simulate Meta's CLIENT side of the Flow endpoint protocol
 * (encrypt the AES key with our public key; AES-128-GCM the payload)
 * and assert our SERVER side (decrypt request, encrypt response)
 * round-trips exactly. This proves the wire format independently of a
 * live Meta call — the risky crypto is verified here, not in prod.
 */

const AES_TAG_LENGTH = 16

/** Mimic what Meta's client does before POSTing to our endpoint. */
function metaClientEncryptRequest(
  payload: FlowRequestBody,
  publicKeyPem: string,
): {
  encrypted_aes_key: string
  encrypted_flow_data: string
  initial_vector: string
  aesKey: Buffer
  iv: Buffer
} {
  const aesKey = crypto.randomBytes(16) // AES-128
  const iv = crypto.randomBytes(16)

  const encryptedAesKey = crypto.publicEncrypt(
    {
      key: crypto.createPublicKey(publicKeyPem),
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
    },
    aesKey,
  )

  const cipher = crypto.createCipheriv('aes-128-gcm', aesKey, iv)
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf-8'),
    cipher.final(),
    cipher.getAuthTag(), // tag appended — matches Meta's format
  ])

  return {
    encrypted_aes_key: encryptedAesKey.toString('base64'),
    encrypted_flow_data: encrypted.toString('base64'),
    initial_vector: iv.toString('base64'),
    aesKey,
    iv,
  }
}

/** Mimic Meta decrypting OUR response: same AES key, bit-flipped IV. */
function metaClientDecryptResponse(
  responseB64: string,
  aesKey: Buffer,
  iv: Buffer,
): unknown {
  const flippedIv = Buffer.from(iv.map((b) => ~b))
  const raw = Buffer.from(responseB64, 'base64')
  const cipherText = raw.subarray(0, -AES_TAG_LENGTH)
  const tag = raw.subarray(-AES_TAG_LENGTH)
  const decipher = crypto.createDecipheriv('aes-128-gcm', aesKey, flippedIv)
  decipher.setAuthTag(tag)
  const out = Buffer.concat([decipher.update(cipherText), decipher.final()])
  return JSON.parse(out.toString('utf-8'))
}

describe('flow-crypto round-trip', () => {
  it('decrypts a request Meta encrypted with our public key', () => {
    const { publicKeyPem, privateKeyPem } = generateFlowKeyPair()
    const payload: FlowRequestBody = {
      version: '3.0',
      action: 'ping',
    }
    const req = metaClientEncryptRequest(payload, publicKeyPem)

    const { decryptedBody } = decryptFlowRequest(req, privateKeyPem)
    expect(decryptedBody).toEqual(payload)
  })

  it('round-trips a data_exchange payload with nested data', () => {
    const { publicKeyPem, privateKeyPem } = generateFlowKeyPair()
    const payload: FlowRequestBody = {
      version: '3.0',
      action: 'data_exchange',
      screen: 'APPOINTMENT',
      data: { date: '2026-07-10', department: 'cardiology' },
      flow_token: 'tok_abc123',
    }
    const req = metaClientEncryptRequest(payload, publicKeyPem)

    const { decryptedBody } = decryptFlowRequest(req, privateKeyPem)
    expect(decryptedBody).toEqual(payload)
  })

  it('produces a response Meta can decrypt with the flipped IV', () => {
    const { publicKeyPem, privateKeyPem } = generateFlowKeyPair()
    const req = metaClientEncryptRequest(
      { version: '3.0', action: 'ping' },
      publicKeyPem,
    )

    const { aesKeyBuffer, initialVectorBuffer } = decryptFlowRequest(
      req,
      privateKeyPem,
    )
    const response = { data: { status: 'active' } }
    const encrypted = encryptFlowResponse(
      response,
      aesKeyBuffer,
      initialVectorBuffer,
    )

    // Meta decrypts with the ORIGINAL iv it sent, flipped on its side.
    const decrypted = metaClientDecryptResponse(encrypted, req.aesKey, req.iv)
    expect(decrypted).toEqual(response)
  })

  it('throws FlowEndpointError(421) when the private key does not match', () => {
    const { publicKeyPem } = generateFlowKeyPair()
    const { privateKeyPem: wrongPrivate } = generateFlowKeyPair()
    const req = metaClientEncryptRequest(
      { version: '3.0', action: 'ping' },
      publicKeyPem,
    )

    try {
      decryptFlowRequest(req, wrongPrivate)
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(FlowEndpointError)
      expect((err as FlowEndpointError).statusCode).toBe(421)
    }
  })

  it('throws 400 when required fields are absent', () => {
    const { privateKeyPem } = generateFlowKeyPair()
    expect(() => decryptFlowRequest({}, privateKeyPem)).toThrow(FlowEndpointError)
  })
})
