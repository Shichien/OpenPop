import { deflateRawSync, inflateRawSync } from "node:zlib";

const MAGIC_ROOM = Buffer.from("RTM3", "ascii");
const MAGIC_COLLECTION = Buffer.from("RTMC", "ascii");
const ROOM_VERSION = 0x02;
const COLLECTION_VERSION = 0x01;
const POS_SCALE = 100;
const UNKNOWN_ACTION = "move";
const MOTION_IDLE_THRESHOLD = 0.03;
const MOTION_RUN_THRESHOLD = 0.14;
const MOTION_VERTICAL_THRESHOLD = 0.12;

const ACTION_RULES: ReadonlyArray<readonly [string, string]> = [
  ["sd air brake", "dash"], ["sd charge", "dash"], ["dash", "dash"],
  ["superdash", "dash"], ["super dash", "dash"], ["shadow dash", "dash"],
  ["air dash", "dash"], ["walljump", "jump"], ["wall jump", "jump"],
  ["double jump", "jump"], ["monarch wings", "jump"], ["crystal", "dash"],
  ["cyclone", "attack"], ["slash", "attack"], ["attack", "attack"],
  ["nail", "attack"], ["great slash", "attack"], ["dash slash", "attack"],
  ["cast", "spell"], ["spell", "spell"], ["scream", "spell"],
  ["shriek", "spell"], ["wraith", "spell"], ["dive", "spell"],
  ["ddark", "spell"], ["desolate dive", "spell"], ["descending dark", "spell"],
  ["focus", "focus"], ["heal", "focus"], ["wall slide", "wall"],
  ["wall cling", "wall"], ["wall", "wall"], ["climb", "climb"],
  ["ledge", "climb"], ["jump", "jump"], ["fall", "fall"],
  ["land", "land"], ["look", "idle"], ["hurt", "hurt"],
  ["hit", "hurt"], ["stun", "hurt"], ["recoil", "hurt"],
  ["idle", "idle"], ["stand", "idle"], ["run", "run"], ["walk", "run"],
];

export class ReplayParseError extends Error {}

export type RoomKey = {
  sceneName: string;
  entryFromScene: string;
  exitToScene: string;
};

export type FrameState = {
  x: number;
  y: number;
  facingRight: boolean;
  animClip: string;
  animFrame: number;
  action: string;
};

export type ActionSegment = {
  startFrame: number;
  endFrame: number;
  action: string;
  clip: string;
};

export type RecordedRoom = {
  key: RoomKey;
  totalTime: number;
  frames: Array<[number, number]>;
  frameStates: FrameState[];
  actionSequence: ActionSegment[];
};

export function classifyAction(animClip: string): string {
  const normalized = String(animClip || "").trim().toLowerCase();
  if (!normalized) return UNKNOWN_ACTION;
  return ACTION_RULES.find(([token]) => normalized.includes(token))?.[1] ?? UNKNOWN_ACTION;
}

export function buildActionSequence(frameStates: FrameState[]): ActionSegment[] {
  if (!frameStates.length) return [];
  const segments: ActionSegment[] = [];
  let startFrame = 0;
  let currentAction = frameStates[0].action;
  let currentClip = frameStates[0].animClip;
  for (let index = 1; index < frameStates.length; index += 1) {
    const state = frameStates[index];
    if (state.action === currentAction && state.animClip === currentClip) continue;
    segments.push({ startFrame, endFrame: index - 1, action: currentAction, clip: currentClip });
    startFrame = index;
    currentAction = state.action;
    currentClip = state.animClip;
  }
  segments.push({
    startFrame,
    endFrame: frameStates.length - 1,
    action: currentAction,
    clip: currentClip,
  });
  return segments;
}

export function refineActionsWithMotion(frameStates: FrameState[]): FrameState[] {
  if (!frameStates.length) return [];
  const lastIndex = frameStates.length - 1;
  return frameStates.map((state, index) => {
    if (state.action !== UNKNOWN_ACTION) return state;
    const left = frameStates[index - 1] ?? state;
    const right = frameStates[index + 1] ?? state;
    const dx = right.x - left.x;
    const dy = right.y - left.y;
    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);
    let action = UNKNOWN_ACTION;
    if (absDy >= MOTION_VERTICAL_THRESHOLD) action = dy > 0 ? "jump" : "fall";
    else if (absDx >= MOTION_RUN_THRESHOLD) action = "run";
    else if (absDx <= MOTION_IDLE_THRESHOLD && absDy <= MOTION_IDLE_THRESHOLD) action = "idle";
    return index <= lastIndex ? { ...state, action } : state;
  });
}

class Cursor {
  private offset = 0;

  constructor(private readonly buffer: Buffer) {}

  read(size: number): Buffer {
    const end = this.offset + size;
    if (size < 0 || end > this.buffer.length) throw new ReplayParseError("Unexpected end of replay blob");
    const chunk = this.buffer.subarray(this.offset, end);
    this.offset = end;
    return chunk;
  }

  readByte(): number { return this.read(1).readUInt8(0); }
  readUInt16(): number { return this.read(2).readUInt16LE(0); }
  readInt16(): number { return this.read(2).readInt16LE(0); }
  readInt32(): number { return this.read(4).readInt32LE(0); }
  readFloat(): number { return this.read(4).readFloatLE(0); }
  readString(): string { return this.read(this.readUInt16()).toString("utf8"); }
}

function readSvlq(cursor: Cursor): number {
  let value = 0;
  let shift = 0;
  while (true) {
    const byte = cursor.readByte();
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
    if (shift > 28) throw new ReplayParseError("Replay integer is too large");
  }
  return (value & 1) === 0 ? value >>> 1 : -((value >>> 1) + 1);
}

function decodeSecondOrder(stream: Buffer, frameCount: number): number[] {
  if (frameCount === 0) return [];
  const cursor = new Cursor(stream);
  const values = [cursor.readInt16()];
  if (frameCount === 1) return values;
  values.push(values[0] + readSvlq(cursor));
  for (let index = 2; index < frameCount; index += 1) {
    values.push(readSvlq(cursor) + 2 * values[index - 1] - values[index - 2]);
  }
  return values;
}

function decodeRoomBinary(raw: Buffer): RecordedRoom {
  const cursor = new Cursor(raw);
  if (!cursor.read(4).equals(MAGIC_ROOM)) throw new ReplayParseError("Replay blob does not start with RTM3");
  const version = cursor.readByte();
  if (version !== ROOM_VERSION) throw new ReplayParseError(`Unsupported RTM3 version: ${version}`);
  const key: RoomKey = {
    sceneName: cursor.readString(),
    entryFromScene: cursor.readString(),
    exitToScene: cursor.readString(),
  };
  const totalTime = cursor.readFloat();
  const frameCount = cursor.readInt32();
  if (frameCount < 0 || frameCount > 240_000) throw new ReplayParseError(`Implausible frame count: ${frameCount}`);
  const xs = decodeSecondOrder(cursor.read(cursor.readUInt16()), frameCount);
  const ys = decodeSecondOrder(cursor.read(cursor.readUInt16()), frameCount);
  const facingBits = cursor.read(Math.ceil(frameCount / 8));
  const clipCount = cursor.readByte();
  const clipNames = Array.from({ length: clipCount }, () => cursor.readString());
  const clipIndices = clipCount > 0 ? cursor.read(frameCount) : Buffer.alloc(0);
  const animFrames = clipCount > 0 ? cursor.read(frameCount) : Buffer.alloc(0);
  const frameStates = refineActionsWithMotion(xs.map((xRaw, index) => {
    const clipIndex = clipCount > 0 ? clipIndices[index] : 0xff;
    const animClip = clipIndex !== 0xff && clipIndex < clipNames.length ? clipNames[clipIndex] : "";
    return {
      x: xRaw / POS_SCALE,
      y: ys[index] / POS_SCALE,
      facingRight: (facingBits[Math.floor(index / 8)] & (0x80 >> (index % 8))) !== 0,
      animClip,
      animFrame: clipCount > 0 ? animFrames[index] : 0,
      action: classifyAction(animClip),
    };
  }));
  return {
    key,
    totalTime,
    frames: frameStates.map((state) => [state.x, state.y]),
    frameStates,
    actionSequence: buildActionSequence(frameStates),
  };
}

function decodeCollectionBinary(raw: Buffer): RecordedRoom[] {
  const cursor = new Cursor(raw);
  if (!cursor.read(4).equals(MAGIC_COLLECTION)) throw new ReplayParseError("Replay blob does not start with RTMC");
  const version = cursor.readByte();
  if (version !== COLLECTION_VERSION) throw new ReplayParseError(`Unsupported RTMC version: ${version}`);
  const count = cursor.readInt32();
  if (count < 0 || count > 100_000) throw new ReplayParseError(`Implausible collection count: ${count}`);
  return Array.from({ length: count }, () => decodeRoomBinary(cursor.read(cursor.readInt32())));
}

export function decodeShareString(rawText: string): RecordedRoom[] {
  const normalized = String(rawText || "").replace(/\s+/gu, "");
  if (!normalized) return [];
  const chunks = normalized.split(/(?<==)(?=[A-Za-z0-9+/])/u);
  return chunks.flatMap((chunk) => {
    if (!chunk) return [];
    let payload: Buffer;
    try {
      payload = inflateRawSync(Buffer.from(chunk, "base64"));
    } catch (error) {
      throw new ReplayParseError(`Replay blob failed to inflate: ${String(error)}`);
    }
    if (payload.subarray(0, 4).equals(MAGIC_COLLECTION)) return decodeCollectionBinary(payload);
    if (payload.subarray(0, 4).equals(MAGIC_ROOM)) return [decodeRoomBinary(payload)];
    throw new ReplayParseError("Share string chunk had unknown magic");
  });
}

export function decodeReplayModJson(rawText: string): RecordedRoom[] {
  let payload: unknown;
  try { payload = JSON.parse(rawText); } catch (error) {
    throw new ReplayParseError(`ReplayMod JSON could not be parsed: ${String(error)}`);
  }
  const entries = (payload as { entries?: unknown })?.entries;
  if (!Array.isArray(entries)) throw new ReplayParseError("ReplayMod JSON did not contain an entries list");
  return entries.flatMap((entry) => {
    const data = (entry as { data?: unknown })?.data;
    return typeof data === "string" && data.trim() ? decodeShareString(data) : [];
  });
}

export function parseUpload(filename: string, content: Buffer): RecordedRoom[] {
  const text = content.toString("utf8");
  return String(filename || "upload.txt").toLowerCase().endsWith(".json")
    ? decodeReplayModJson(text)
    : decodeShareString(text);
}

class BufferWriter {
  private readonly chunks: Buffer[] = [];

  write(chunk: Buffer): void { this.chunks.push(chunk); }
  writeByte(value: number): void { const chunk = Buffer.allocUnsafe(1); chunk.writeUInt8(value, 0); this.write(chunk); }
  writeUInt16(value: number): void { const chunk = Buffer.allocUnsafe(2); chunk.writeUInt16LE(value, 0); this.write(chunk); }
  writeInt16(value: number): void { const chunk = Buffer.allocUnsafe(2); chunk.writeInt16LE(value, 0); this.write(chunk); }
  writeInt32(value: number): void { const chunk = Buffer.allocUnsafe(4); chunk.writeInt32LE(value, 0); this.write(chunk); }
  writeFloat(value: number): void { const chunk = Buffer.allocUnsafe(4); chunk.writeFloatLE(value, 0); this.write(chunk); }
  writeString(value: string): void {
    const encoded = Buffer.from(value, "utf8");
    this.writeUInt16(encoded.length);
    this.write(encoded);
  }
  finish(): Buffer { return Buffer.concat(this.chunks); }
}

function writeSvlq(writer: BufferWriter, value: number): void {
  let encoded = value >= 0 ? value * 2 : (-value * 2) - 1;
  while (true) {
    const byte = encoded & 0x7f;
    encoded = Math.floor(encoded / 128);
    writer.writeByte(encoded ? byte | 0x80 : byte);
    if (!encoded) return;
  }
}

function encodeSecondOrder(points: Array<[number, number]>, useX: boolean): Buffer {
  if (!points.length) return Buffer.alloc(0);
  const values = points.map((point) => Math.round(point[useX ? 0 : 1] * POS_SCALE));
  const writer = new BufferWriter();
  writer.writeInt16(values[0]);
  if (values.length > 1) writeSvlq(writer, values[1] - values[0]);
  for (let index = 2; index < values.length; index += 1) {
    writeSvlq(writer, values[index] - (2 * values[index - 1]) + values[index - 2]);
  }
  return writer.finish();
}

function encodeRoom(room: RecordedRoom): Buffer {
  const frameCount = room.frames.length;
  const xs = encodeSecondOrder(room.frames, true);
  const ys = encodeSecondOrder(room.frames, false);
  const facing = Buffer.alloc(Math.ceil(frameCount / 8));
  const clipTable: string[] = [];
  const clipIndices = Buffer.alloc(frameCount, 0xff);
  const animFrames = Buffer.alloc(frameCount);
  const hasStates = room.frameStates.length === frameCount;
  let hasAnimation = false;
  for (let index = 0; index < frameCount; index += 1) {
    if (!hasStates) continue;
    const state = room.frameStates[index];
    if (state.facingRight) facing[Math.floor(index / 8)] |= 0x80 >> (index % 8);
    if (state.animClip) {
      hasAnimation = true;
      if (!clipTable.includes(state.animClip)) clipTable.push(state.animClip);
      clipIndices[index] = Math.min(clipTable.indexOf(state.animClip), 0xfe);
    }
    animFrames[index] = Math.max(0, Math.min(Math.trunc(state.animFrame), 0xff));
  }
  const clipCount = hasAnimation ? clipTable.length : 0;
  const writer = new BufferWriter();
  writer.write(MAGIC_ROOM);
  writer.writeByte(ROOM_VERSION);
  writer.writeString(room.key.sceneName);
  writer.writeString(room.key.entryFromScene);
  writer.writeString(room.key.exitToScene);
  writer.writeFloat(room.totalTime);
  writer.writeInt32(frameCount);
  writer.writeUInt16(xs.length);
  writer.write(xs);
  writer.writeUInt16(ys.length);
  writer.write(ys);
  writer.write(facing);
  writer.writeByte(clipCount);
  if (clipCount > 0) {
    clipTable.forEach((clip) => writer.writeString(clip));
    writer.write(clipIndices);
    writer.write(animFrames);
  }
  return writer.finish();
}

export function encodeCollection(rooms: RecordedRoom[]): string {
  const writer = new BufferWriter();
  writer.write(MAGIC_COLLECTION);
  writer.writeByte(COLLECTION_VERSION);
  writer.writeInt32(rooms.length);
  rooms.forEach((room) => {
    const blob = encodeRoom(room);
    writer.writeInt32(blob.length);
    writer.write(blob);
  });
  return deflateRawSync(writer.finish(), { level: 9 }).toString("base64");
}

export function toApiRoom(room: RecordedRoom) {
  return {
    key: {
      scene_name: room.key.sceneName,
      entry_from_scene: room.key.entryFromScene,
      exit_to_scene: room.key.exitToScene,
    },
    total_time: room.totalTime,
    frames: room.frames,
    frame_states: room.frameStates.map((state) => ({
      x: state.x,
      y: state.y,
      facing_right: state.facingRight,
      anim_clip: state.animClip,
      anim_frame: state.animFrame,
      action: state.action,
    })),
    action_sequence: room.actionSequence.map((segment) => ({
      start_frame: segment.startFrame,
      end_frame: segment.endFrame,
      action: segment.action,
      clip: segment.clip,
    })),
  };
}
