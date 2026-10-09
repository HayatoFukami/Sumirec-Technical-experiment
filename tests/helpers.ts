import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import { recordingConfig } from '../src/config.js';
import type { Clock } from '../src/model.js';
import type { VoiceCallbacks, VoicePort } from '../src/receiver.js';
import type { SessionOptions } from '../src/session.js';

export const GUILD = '123456789012345678';
export const CHANNEL = '223456789012345678';
export const A = '323456789012345678';
export const B = '423456789012345678';
export const C = '523456789012345678';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
export async function config() {
  const root = await mkdtemp(join(tmpdir(), 'discord-poc-'));
  roots.push(root);
  return { ...recordingConfig({}), root };
}
export class TestClock implements Clock {
  now = 0;
  wall = Date.parse('2026-10-08T00:00:00Z');
  monotonicMs(): number { return this.now; }
  wallNow(): Date { return new Date(this.wall); }
}
export class TestVoice implements VoicePort {
  callbacks?: VoiceCallbacks;
  users: string[] = [];
  connects = 0;
  closes = 0;
  failConnect = false;
  async connect(callbacks: VoiceCallbacks): Promise<void> {
    this.connects++; this.callbacks = callbacks;
    if (this.failConnect) throw new Error('test connection failure');
    callbacks.state('ready');
  }
  setUsers(users: string[]): void { this.users = users; }
  close(): void { this.closes++; this.users = []; }
  emit(id: string, ms = 20): void { this.callbacks?.packet(id, Buffer.from([ms])); }
}
export function fixture(participants = [A, B]) {
  const clock = new TestClock();
  const voice = new TestVoice();
  const notices: string[] = [];
  let deleted = 0;
  const options: SessionOptions = {
    guildId: GUILD, channelId: CHANNEL, ownerId: A, participants, voice, clock,
    notify: async (message) => { notices.push(message); },
    decoderFactory: () => ({ decode: (packet) => Buffer.alloc(packet[0]! * 48 * 4, 1), delete: () => { deleted++; } }),
  };
  return { clock, voice, notices, options, deleted: () => deleted };
}
