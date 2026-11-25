import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const TEAM_NAMES = ["烈焰隊", "疾風隊", "森靈隊", "雷光隊", "幻紫隊"];
const MAX_HP = 10000;

interface TeamState {
  name: string;
  damage: number;
  runner: number;
  runnerCount: number;
}

interface RoomState {
  room: string;
  hp: number;
  maxHp: number;
  paused: boolean;
  ended: boolean;
  teams: TeamState[];
  updatedAt: number;
  storage?: "upstash" | "memory";
  redisError?: string;
}

const globalForStore = globalThis as unknown as {
  __mathBattleMemoryStore?: Map<string, RoomState>;
};
const memoryStore =
  globalForStore.__mathBattleMemoryStore ??
  (globalForStore.__mathBattleMemoryStore = new Map<string, RoomState>());

function createInitialRoom(room: string): RoomState {
  return {
    room,
    hp: MAX_HP,
    maxHp: MAX_HP,
    paused: false,
    ended: false,
    teams: TEAM_NAMES.map(function (name) {
      return {
        name: name,
        damage: 0,
        runner: 1,
        runnerCount: 6,
      };
    }),
    updatedAt: Date.now(),
  };
}

function sanitizeRestUrl(raw: string): string {
  const trimmed = raw.trim();
  const match = trimmed.match(/https:\/\/[^\s\]\[()]+/);
  const cleaned = (match ? match[0] : trimmed).replace(/\/+$/, "");
  try {
    const parsed = new URL(cleaned);
    return parsed.origin;
  } catch {
    return "";
  }
}

function getRedisConfig() {
  const rawUrl = process.env.UPSTASH_REDIS_REST_URL || "";
  const rawToken = process.env.UPSTASH_REDIS_REST_TOKEN || "";
  const url = sanitizeRestUrl(rawUrl);
  const token = rawToken.trim();
  if (!url || !token) {
    return {
      config: null,
      reason: !rawUrl
        ? "UPSTASH_REDIS_REST_URL missing"
        : !url
        ? "UPSTASH_REDIS_REST_URL invalid"
        : "UPSTASH_REDIS_REST_TOKEN missing",
    };
  }
  return { config: { url: url, token: token }, reason: "" };
}

function parseRoomPayload(raw: unknown, room: string): RoomState {
  if (!raw) return createInitialRoom(room);
  const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as RoomState).teams)) {
    return createInitialRoom(room);
  }
  const r = parsed as RoomState;
  return {
    room: String(r.room || room),
    hp: Number.isFinite(Number(r.hp)) ? Number(r.hp) : MAX_HP,
    maxHp: Number.isFinite(Number(r.maxHp)) ? Number(r.maxHp) : MAX_HP,
    paused: Boolean(r.paused),
    ended: Boolean(r.ended),
    teams: TEAM_NAMES.map(function (name, idx) {
      const item = r.teams[idx] || ({} as TeamState);
      return {
        name: String(item.name || name),
        damage: Number.isFinite(Number(item.damage)) ? Number(item.damage) : 0,
        runner: Number.isFinite(Number(item.runner)) ? Number(item.runner) : 1,
        runnerCount: Number.isFinite(Number(item.runnerCount)) ? Number(item.runnerCount) : 6,
      };
    }),
    updatedAt: Number(r.updatedAt || Date.now()),
  };
}

async function loadRoom(room: string): Promise<RoomState> {
  const key = "math_battle:room:" + room;
  const { config: redis, reason } = getRedisConfig();
  if (redis) {
    try {
      const res = await fetch(redis.url + "/get/" + encodeURIComponent(key), {
        headers: { Authorization: "Bearer " + redis.token },
        cache: "no-store",
      });
      const text = await res.text();
      if (res.ok && text) {
        const data = JSON.parse(text);
        if (data && data.result !== undefined && data.result !== null) {
          const loaded = parseRoomPayload(data.result, room);
          loaded.storage = "upstash";
          return loaded;
        }
        const initial = createInitialRoom(room);
        await saveRoom(initial);
        initial.storage = "upstash";
        return initial;
      }
      const fallback = memoryStore.get(room) || createInitialRoom(room);
      fallback.storage = "memory";
      fallback.redisError = "GET status " + res.status + ": " + text.slice(0, 120);
      return fallback;
    } catch (err) {
      const fallback = memoryStore.get(room) || createInitialRoom(room);
      fallback.storage = "memory";
      fallback.redisError = String(err);
      return fallback;
    }
  }
  if (!memoryStore.has(room)) {
    memoryStore.set(room, createInitialRoom(room));
  }
  const mem = memoryStore.get(room) as RoomState;
  mem.storage = "memory";
  mem.redisError = reason;
  return mem;
}

async function saveRoom(state: RoomState): Promise<void> {
  state.updatedAt = Date.now();
  const key = "math_battle:room:" + state.room;
  const { config: redis, reason } = getRedisConfig();
  const payloadToStore: RoomState = {
    room: state.room,
    hp: state.hp,
    maxHp: state.maxHp,
    paused: state.paused,
    ended: state.ended,
    teams: state.teams,
    updatedAt: state.updatedAt,
  };
  if (redis) {
    try {
      const res = await fetch(redis.url + "/set/" + encodeURIComponent(key), {
        method: "POST",
        headers: {
          Authorization: "Bearer " + redis.token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(JSON.stringify(payloadToStore)),
        cache: "no-store",
      });
      const text = await res.text();
      if (res.ok) {
        state.storage = "upstash";
        delete state.redisError;
      } else {
        state.storage = "memory";
        state.redisError = "SET status " + res.status + ": " + text.slice(0, 120);
      }
    } catch (err) {
      state.storage = "memory";
      state.redisError = String(err);
    }
  } else {
    state.storage = "memory";
    state.redisError = reason;
  }
  memoryStore.set(state.room, state);
}

export async function GET(req: NextRequest) {
  try {
    const room = (req.nextUrl.searchParams.get("room") || "506").trim() || "506";
    const state = await loadRoom(room);
    return NextResponse.json(state, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("GET /api/battle-room error:", err);
    return NextResponse.json({ error: "GET failed", detail: String(err) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const rawBody = await req.text();
    let body: Record<string, unknown> = {};
    if (rawBody) {
      try {
        body = JSON.parse(rawBody) as Record<string, unknown>;
      } catch {
        body = {};
      }
    }
    const qRoom = req.nextUrl.searchParams.get("room") || "506";
    const room = String(body.room || qRoom || "506").trim() || "506";
    const action = String(body.action || "hit");
    const state = await loadRoom(room);

    if (action === "reset") {
      const fresh = createInitialRoom(room);
      await saveRoom(fresh);
      return NextResponse.json(fresh);
    }

    if (action === "togglePause") {
      state.paused = !state.paused;
      await saveRoom(state);
      return NextResponse.json(state);
    }

    if (action === "end") {
      state.ended = true;
      await saveRoom(state);
      return NextResponse.json(state);
    }

    if (action === "adjustRunnerCount") {
      const teamIndex = Number(body.teamIndex ?? 0);
      const runnerCount = Math.min(8, Math.max(3, Number(body.runnerCount ?? 6)));
      if (state.teams[teamIndex]) {
        state.teams[teamIndex].runnerCount = runnerCount;
        if (state.teams[teamIndex].runner > runnerCount) {
          state.teams[teamIndex].runner = runnerCount;
        }
      }
      await saveRoom(state);
      return NextResponse.json(state);
    }

    if (action === "hit") {
      if (!state.paused && !state.ended) {
        const teamIndex = Number(body.teamIndex ?? 0);
        const rawDmg = Number(body.damage ?? 0);
        const damage = Number.isFinite(rawDmg) ? Math.max(0, rawDmg) : 0;
        const team = state.teams[teamIndex];
        if (team) {
          team.damage += damage;
          state.hp = Math.max(0, state.hp - damage);
          if (Boolean(body.advanceRunner)) {
            team.runner = team.runner < team.runnerCount ? team.runner + 1 : 1;
          }
          if (state.hp === 0) {
            state.ended = true;
          }
        }
      }
      await saveRoom(state);
      return NextResponse.json(state);
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (err) {
    console.error("POST /api/battle-room error:", err);
    return NextResponse.json({ error: "POST failed", detail: String(err) }, { status: 500 });
  }
}