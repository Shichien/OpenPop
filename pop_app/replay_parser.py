from __future__ import annotations

import base64
import io
import json
import re
import struct
import zlib
from dataclasses import dataclass, field
from pathlib import Path


MAGIC_ROOM = b"RTM3"
MAGIC_COLLECTION = b"RTMC"
ROOM_VERSION = 0x02
COLLECTION_VERSION = 0x01
POS_SCALE = 100.0
UNKNOWN_ACTION = "move"
MOTION_IDLE_THRESHOLD = 0.03
MOTION_RUN_THRESHOLD = 0.14
MOTION_VERTICAL_THRESHOLD = 0.12
ACTION_RULES: tuple[tuple[str, str], ...] = (
    ("sd air brake", "dash"),
    ("sd charge", "dash"),
    ("dash", "dash"),
    ("superdash", "dash"),
    ("super dash", "dash"),
    ("shadow dash", "dash"),
    ("air dash", "dash"),
    ("walljump", "jump"),
    ("wall jump", "jump"),
    ("double jump", "jump"),
    ("monarch wings", "jump"),
    ("crystal", "dash"),
    ("cyclone", "attack"),
    ("slash", "attack"),
    ("attack", "attack"),
    ("nail", "attack"),
    ("great slash", "attack"),
    ("dash slash", "attack"),
    ("cast", "spell"),
    ("spell", "spell"),
    ("scream", "spell"),
    ("shriek", "spell"),
    ("wraith", "spell"),
    ("dive", "spell"),
    ("ddark", "spell"),
    ("desolate dive", "spell"),
    ("descending dark", "spell"),
    ("focus", "focus"),
    ("heal", "focus"),
    ("wall slide", "wall"),
    ("wall cling", "wall"),
    ("wall", "wall"),
    ("climb", "climb"),
    ("ledge", "climb"),
    ("jump", "jump"),
    ("fall", "fall"),
    ("land", "land"),
    ("look", "idle"),
    ("hurt", "hurt"),
    ("hit", "hurt"),
    ("stun", "hurt"),
    ("recoil", "hurt"),
    ("idle", "idle"),
    ("stand", "idle"),
    ("run", "run"),
    ("walk", "run"),
)


class ReplayParseError(ValueError):
    pass


@dataclass(frozen=True)
class RoomKey:
    scene_name: str
    entry_from_scene: str
    exit_to_scene: str


@dataclass(frozen=True)
class FrameState:
    x: float
    y: float
    facing_right: bool
    anim_clip: str
    anim_frame: int
    action: str


@dataclass(frozen=True)
class ActionSegment:
    start_frame: int
    end_frame: int
    action: str
    clip: str


@dataclass(frozen=True)
class RecordedRoom:
    key: RoomKey
    total_time: float
    frames: list[tuple[float, float]]
    frame_states: list[FrameState] = field(default_factory=list)
    action_sequence: list[ActionSegment] = field(default_factory=list)

    @property
    def frame_count(self) -> int:
        return len(self.frames)


def classify_action(anim_clip: str) -> str:
    normalized = (anim_clip or "").strip().lower()
    if not normalized:
        return UNKNOWN_ACTION
    for token, action in ACTION_RULES:
        if token in normalized:
            return action
    return UNKNOWN_ACTION


def build_action_sequence(frame_states: list[FrameState]) -> list[ActionSegment]:
    if not frame_states:
        return []

    segments: list[ActionSegment] = []
    start_index = 0
    current_action = frame_states[0].action
    current_clip = frame_states[0].anim_clip

    for index in range(1, len(frame_states)):
        state = frame_states[index]
        if state.action == current_action and state.anim_clip == current_clip:
            continue
        segments.append(
            ActionSegment(
                start_frame=start_index,
                end_frame=index - 1,
                action=current_action,
                clip=current_clip,
            )
        )
        start_index = index
        current_action = state.action
        current_clip = state.anim_clip

    segments.append(
        ActionSegment(
            start_frame=start_index,
            end_frame=len(frame_states) - 1,
            action=current_action,
            clip=current_clip,
        )
    )
    return segments


def refine_actions_with_motion(frame_states: list[FrameState]) -> list[FrameState]:
    if not frame_states:
        return []

    refined_states: list[FrameState] = []
    last_index = len(frame_states) - 1
    for index, state in enumerate(frame_states):
        if state.action != UNKNOWN_ACTION:
            refined_states.append(state)
            continue

        left = frame_states[index - 1] if index > 0 else state
        right = frame_states[index + 1] if index < last_index else state
        dx = right.x - left.x
        dy = right.y - left.y
        abs_dx = abs(dx)
        abs_dy = abs(dy)

        if abs_dy >= MOTION_VERTICAL_THRESHOLD:
            action = "jump" if dy > 0 else "fall"
        elif abs_dx >= MOTION_RUN_THRESHOLD:
            action = "run"
        elif abs_dx <= MOTION_IDLE_THRESHOLD and abs_dy <= MOTION_IDLE_THRESHOLD:
            action = "idle"
        else:
            action = UNKNOWN_ACTION

        refined_states.append(
            FrameState(
                x=state.x,
                y=state.y,
                facing_right=state.facing_right,
                anim_clip=state.anim_clip,
                anim_frame=state.anim_frame,
                action=action,
            )
        )
    return refined_states


class Cursor:
    def __init__(self, data: bytes) -> None:
        self.buffer = data
        self.offset = 0

    def read(self, size: int) -> bytes:
        end = self.offset + size
        if end > len(self.buffer):
            raise ReplayParseError("Unexpected end of replay blob")
        chunk = self.buffer[self.offset:end]
        self.offset = end
        return chunk

    def read_byte(self) -> int:
        return self.read_struct("<B")

    def read_uint16(self) -> int:
        return self.read_struct("<H")

    def read_int16(self) -> int:
        return self.read_struct("<h")

    def read_int32(self) -> int:
        return self.read_struct("<i")

    def read_float(self) -> float:
        return self.read_struct("<f")

    def read_struct(self, fmt: str):
        size = struct.calcsize(fmt)
        chunk = self.read(size)
        return struct.unpack(fmt, chunk)[0]

    def read_string(self) -> str:
        length = self.read_uint16()
        return self.read(length).decode("utf-8")


def read_svlq(cursor: Cursor) -> int:
    value = 0
    shift = 0
    while True:
        byte = cursor.read_byte()
        value |= (byte & 0x7F) << shift
        if (byte & 0x80) == 0:
            break
        shift += 7
    return (value >> 1) if (value & 1) == 0 else -((value >> 1) + 1)


def decode_second_order(stream: bytes, frame_count: int) -> list[int]:
    if frame_count == 0:
        return []
    cursor = Cursor(stream)
    values = [cursor.read_int16()]
    if frame_count == 1:
        return values
    values.append(values[0] + read_svlq(cursor))
    for _ in range(2, frame_count):
        values.append(read_svlq(cursor) + 2 * values[-1] - values[-2])
    return values


def inflate_raw(blob: bytes) -> bytes:
    try:
        return zlib.decompress(blob, -zlib.MAX_WBITS)
    except zlib.error as exc:
        raise ReplayParseError(f"Replay blob failed to inflate: {exc}") from exc


def decode_room_binary(raw: bytes) -> RecordedRoom:
    cursor = Cursor(raw)
    magic = cursor.read(4)
    if magic != MAGIC_ROOM:
        raise ReplayParseError("Replay blob does not start with RTM3")

    version = cursor.read_byte()
    if version != ROOM_VERSION:
        raise ReplayParseError(f"Unsupported RTM3 version: {version}")

    scene_name = cursor.read_string()
    entry_from_scene = cursor.read_string()
    exit_to_scene = cursor.read_string()
    total_time = cursor.read_float()
    frame_count = cursor.read_int32()

    xs = decode_second_order(cursor.read(cursor.read_uint16()), frame_count)
    ys = decode_second_order(cursor.read(cursor.read_uint16()), frame_count)
    facing_bits = cursor.read((frame_count + 7) // 8)

    clip_count = cursor.read_byte()
    clip_names: list[str] = []
    clip_indices: bytes = b""
    anim_frames: bytes = b""
    if clip_count > 0:
        clip_names = [cursor.read_string() for _ in range(clip_count)]
        clip_indices = cursor.read(frame_count)
        anim_frames = cursor.read(frame_count)

    frame_states: list[FrameState] = []
    for index, (x_raw, y_raw) in enumerate(zip(xs, ys, strict=True)):
        x = x_raw / POS_SCALE
        y = y_raw / POS_SCALE
        facing_right = (facing_bits[index // 8] & (0x80 >> (index % 8))) != 0
        anim_clip = ""
        anim_frame = 0
        if clip_count > 0 and index < len(clip_indices):
            clip_index = clip_indices[index]
            if clip_index != 0xFF and clip_index < len(clip_names):
                anim_clip = clip_names[clip_index]
            if index < len(anim_frames):
                anim_frame = int(anim_frames[index])

        frame_states.append(
            FrameState(
                x=x,
                y=y,
                facing_right=facing_right,
                anim_clip=anim_clip,
                anim_frame=anim_frame,
                action=classify_action(anim_clip),
            )
        )

    frame_states = refine_actions_with_motion(frame_states)
    frames = [(state.x, state.y) for state in frame_states]
    return RecordedRoom(
        key=RoomKey(
            scene_name=scene_name,
            entry_from_scene=entry_from_scene,
            exit_to_scene=exit_to_scene,
        ),
        total_time=total_time,
        frames=frames,
        frame_states=frame_states,
        action_sequence=build_action_sequence(frame_states),
    )


def decode_collection_binary(raw: bytes) -> list[RecordedRoom]:
    cursor = Cursor(raw)
    magic = cursor.read(4)
    if magic != MAGIC_COLLECTION:
        raise ReplayParseError("Replay blob does not start with RTMC")

    version = cursor.read_byte()
    if version != COLLECTION_VERSION:
        raise ReplayParseError(f"Unsupported RTMC version: {version}")

    count = cursor.read_int32()
    if count < 0 or count > 100_000:
        raise ReplayParseError(f"Implausible collection count: {count}")

    rooms: list[RecordedRoom] = []
    for _ in range(count):
        blob_length = cursor.read_int32()
        rooms.append(decode_room_binary(cursor.read(blob_length)))
    return rooms


def decode_share_string(raw_text: str) -> list[RecordedRoom]:
    normalized = re.sub(r"\s+", "", raw_text)
    if not normalized:
        return []

    chunks = re.split(r"(?<==)(?=[A-Za-z0-9+/])", normalized)
    rooms: list[RecordedRoom] = []

    for chunk in chunks:
        if not chunk:
            continue
        payload = inflate_raw(base64.b64decode(chunk))
        if payload.startswith(MAGIC_COLLECTION):
            rooms.extend(decode_collection_binary(payload))
        elif payload.startswith(MAGIC_ROOM):
            rooms.append(decode_room_binary(payload))
        else:
            raise ReplayParseError("Share string chunk had unknown magic")
    return rooms


def decode_replaymod_json(raw_text: str) -> list[RecordedRoom]:
    try:
        payload = json.loads(raw_text)
    except json.JSONDecodeError as exc:
        raise ReplayParseError(f"ReplayMod JSON could not be parsed: {exc}") from exc

    entries = payload.get("entries")
    if not isinstance(entries, list):
        raise ReplayParseError("ReplayMod JSON did not contain an entries list")

    rooms: list[RecordedRoom] = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        data = entry.get("data")
        if isinstance(data, str) and data.strip():
            rooms.extend(decode_share_string(data))
    return rooms


def parse_upload(filename: str, content: bytes) -> list[RecordedRoom]:
    suffix = Path(filename or "upload.txt").suffix.lower()
    raw_text = content.decode("utf-8", errors="replace")
    if suffix == ".json":
        return decode_replaymod_json(raw_text)
    return decode_share_string(raw_text)


def write_string(buffer: io.BytesIO, value: str) -> None:
    encoded = value.encode("utf-8")
    buffer.write(struct.pack("<H", len(encoded)))
    buffer.write(encoded)


def write_svlq(buffer: io.BytesIO, value: int) -> None:
    encoded = (value << 1) if value >= 0 else ((-value << 1) - 1)
    while True:
        byte = encoded & 0x7F
        encoded >>= 7
        if encoded:
            buffer.write(bytes([byte | 0x80]))
        else:
            buffer.write(bytes([byte]))
            return


def encode_second_order(points: list[tuple[float, float]], use_x: bool) -> bytes:
    if not points:
        return b""
    ints = [round((point[0] if use_x else point[1]) * POS_SCALE) for point in points]
    buffer = io.BytesIO()
    buffer.write(struct.pack("<h", ints[0]))
    if len(ints) == 1:
        return buffer.getvalue()
    write_svlq(buffer, ints[1] - ints[0])
    for index in range(2, len(ints)):
        write_svlq(buffer, ints[index] - 2 * ints[index - 1] + ints[index - 2])
    return buffer.getvalue()


def deflate_raw(data: bytes) -> bytes:
    compressor = zlib.compressobj(level=9, wbits=-zlib.MAX_WBITS)
    return compressor.compress(data) + compressor.flush()


def encode_room(room: RecordedRoom) -> bytes:
    xs = encode_second_order(room.frames, use_x=True)
    ys = encode_second_order(room.frames, use_x=False)
    facing_buffer = bytearray((room.frame_count + 7) // 8)
    clip_table: list[str] = []
    clip_indexes = bytearray(room.frame_count)
    anim_frames = bytearray(room.frame_count)
    has_anim = False

    has_states = len(room.frame_states) == room.frame_count
    for index in range(room.frame_count):
        if has_states:
            state = room.frame_states[index]
            if state.facing_right:
                facing_buffer[index // 8] |= 0x80 >> (index % 8)
            clip_name = state.anim_clip
            if clip_name:
                has_anim = True
                if clip_name not in clip_table:
                    clip_table.append(clip_name)
                clip_indexes[index] = min(clip_table.index(clip_name), 0xFE)
            else:
                clip_indexes[index] = 0xFF
            anim_frames[index] = max(0, min(int(state.anim_frame), 0xFF))
        else:
            clip_indexes[index] = 0xFF

    clip_count = len(clip_table) if has_anim else 0
    blob = io.BytesIO()
    blob.write(MAGIC_ROOM)
    blob.write(bytes([ROOM_VERSION]))
    write_string(blob, room.key.scene_name)
    write_string(blob, room.key.entry_from_scene)
    write_string(blob, room.key.exit_to_scene)
    blob.write(struct.pack("<f", room.total_time))
    blob.write(struct.pack("<i", room.frame_count))
    blob.write(struct.pack("<H", len(xs)))
    blob.write(xs)
    blob.write(struct.pack("<H", len(ys)))
    blob.write(ys)
    blob.write(bytes(facing_buffer))
    blob.write(bytes([clip_count]))
    if clip_count > 0:
        for clip_name in clip_table:
            write_string(blob, clip_name)
        blob.write(bytes(clip_indexes))
        blob.write(bytes(anim_frames))
    return blob.getvalue()


def encode_collection(rooms: list[RecordedRoom]) -> str:
    blob = io.BytesIO()
    blob.write(MAGIC_COLLECTION)
    blob.write(bytes([COLLECTION_VERSION]))
    blob.write(struct.pack("<i", len(rooms)))
    for room in rooms:
        room_blob = encode_room(room)
        blob.write(struct.pack("<i", len(room_blob)))
        blob.write(room_blob)
    return base64.b64encode(deflate_raw(blob.getvalue())).decode("ascii")
