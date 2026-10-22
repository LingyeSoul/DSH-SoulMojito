import { deflateSync } from 'node:zlib'
import {
  decodeCharacterCard,
  encodeCharacterCardPng,
  encodeChunk,
} from '../../src/index.js'

export const SYNTHETIC_CARD_NAME = 'ExampleCard'
export const SYNTHETIC_WORLD_NAME = 'ExampleWorld'

/**
 * Minimal 1x1 grayscale PNG. The card fixture only needs a valid container;
 * the avatar is not third-party artwork.
 */
export function minimalPng(): Uint8Array {
  const signature = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = new Uint8Array([0, 0, 0, 1, 0, 0, 0, 1, 8, 0, 0, 0, 0])
  const idat = deflateSync(Uint8Array.from([0, 0x42]))
  const total = signature.length + ihdr.length + 12 + idat.length + 12 + 12
  const out = new Uint8Array(total)
  let at = 0
  out.set(signature, at); at += signature.length
  const ihdrChunk = encodeChunk('IHDR', ihdr); out.set(ihdrChunk, at); at += ihdrChunk.length
  const idatChunk = encodeChunk('IDAT', new Uint8Array(idat)); out.set(idatChunk, at); at += idatChunk.length
  const iendChunk = encodeChunk('IEND', new Uint8Array(0)); out.set(iendChunk, at)
  return out
}

/**
 * Synthetic V2 card that keeps the top-level V1 fields plus the nested `data`
 * layer, so the roundtrip tests still cover the shape ST actually exports.
 */
export function syntheticCardRaw(): Record<string, unknown> {
  const description = 'A synthetic character used by format tests.'
  const firstMes = 'Hello from the synthetic fixture.'
  return {
    name: SYNTHETIC_CARD_NAME,
    description,
    personality: 'plain',
    first_mes: firstMes,
    avatar: 'none',
    chat: `${SYNTHETIC_CARD_NAME} - 2026-1-1 @00h 00m 00s`,
    mes_example: '',
    scenario: 'A synthetic scenario.',
    create_date: '2026-1-1 @00h 00m 00s',
    talkativeness: '0.5',
    fav: false,
    creatorcomment: 'Synthetic fixture; no third-party content.',
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: SYNTHETIC_CARD_NAME,
      description,
      personality: 'plain',
      scenario: 'A synthetic scenario.',
      first_mes: firstMes,
      mes_example: '',
      creator_notes: 'Synthetic fixture; no third-party content.',
      system_prompt: '',
      post_history_instructions: '',
      alternate_greetings: [],
      tags: [],
      creator: 'fixture',
      character_version: '1.0.0',
      extensions: {},
    },
    tags: [],
  }
}

/** Synthetic card PNG with a `chara` chunk; no third-party card body or image. */
export function syntheticCardPng(): Uint8Array {
  return encodeCharacterCardPng(decodeCharacterCard(syntheticCardRaw()), minimalPng())
}

/** Synthetic ST world-info file with the map-shaped `entries` ST writes. */
export function syntheticWorldRaw(): Record<string, unknown> {
  return {
    name: SYNTHETIC_WORLD_NAME,
    entries: {
      '0': {
        uid: 0, key: ['alpha'], keysecondary: [], comment: 'alpha', content: 'Synthetic alpha entry.',
        constant: false, selective: true, order: 100, position: 0, disable: false,
      },
      '1': {
        uid: 1, key: ['beta'], keysecondary: [], comment: 'beta', content: 'Synthetic beta entry.',
        constant: true, selective: false, order: 90, position: 1, disable: false,
      },
      '2': {
        uid: 2, key: ['gamma'], keysecondary: ['delta'], comment: 'gamma', content: 'Synthetic gamma entry.',
        constant: false, selective: true, order: 80, position: 4, disable: false,
      },
      '3': {
        uid: 3, key: ['epsilon'], keysecondary: [], comment: 'epsilon', content: 'Synthetic epsilon entry.',
        constant: true, selective: false, order: 70, position: 1, disable: true,
      },
    },
  }
}
