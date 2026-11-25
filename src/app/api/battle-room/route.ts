import { NextRequest, NextResponse } from "next/server";

const TEAM_NAMES = ["烈焰隊", "疾風隊", "森靈隊", "雷光隊", "幻紫隊"];
const MAX_HP = 10000;

interface TeamState {
  name: string;
  damage: number;
  runner: number;
  runnerCount: number;
  question?: unknown;
  eliminatedOptions?: number[];
}

interface RoomState {
  room: string;
  hp: number;
  maxHp: number;
  started: boolean;
  paused: boolean;
  ended: boolean;
  teams: TeamState[];
  updatedAt: number;
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
    started: false,
    paused: false,
    ended: false,
    teams: TEAM_NAMES.map((name) => ({
      name,
      damage: 0,
      runner: 1,
      runnerCount: 6,
    })),
    updatedAt: Date.now(),
  };
}

function getRedisConfig() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url, token } : null;
}

async function loadRoom(room: string): Promise<RoomState> {
  const key = `math_battle:room:${room}`;
  const redis = getRedisConfig();
  if (redis) {
    const res = await fetch(`${redis.url}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${redis.token}` },
      cache: "no-store",
    });
    if (res.ok) {
      const data = await res.json();
      if (data?.result) {
        return typeof data.result === "string" ? JSON.parse(data.result) : data.result;
      }
      const initial = createInitialRoom(room);
      await saveRoom(initial);
      return initial;
    }
  }
  if (!memoryStore.has(room)) {
    memoryStore.set(room, createInitialRoom(room));
  }
  return memoryStore.get(room)!;
}

async function saveRoom(state: RoomState): Promise<void> {
  state.updatedAt = Date.now();
  const key = `math_battle:room:${state.room}`;
  const redis = getRedisConfig();
  if (redis) {
    await fetch(`${redis.url}/set/${encodeURIComponent(key)}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${redis.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(JSON.stringify(state)),
      cache: "no-store",
    });
  }
  memoryStore.set(state.room, state);
}

export async function GET(req: NextRequest) {
  const room = (req.nextUrl.searchParams.get("room") || "506").trim() || "506";
  const state = await loadRoom(room);
  return NextResponse.json(state, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const room = String(body.room || req.nextUrl.searchParams.get("room") || "506").trim() || "506";
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

  if (action === "syncQuestion") {
    const teamIndex = Number(body.teamIndex ?? 0);
    const team = state.teams[teamIndex];
    if (team && body.question && typeof body.question === "object") {
      team.question = body.question;
      if (Array.isArray(body.eliminatedOptions)) {
        team.eliminatedOptions = body.eliminatedOptions;
      }
      await saveRoom(state);
    }
    return NextResponse.json(state);
  }

  if (action === "hit") {
    if (!state.paused && !state.ended) {
      const teamIndex = Number(body.teamIndex ?? 0);
      const damage = Math.max(0, Number(body.damage ?? 0));
      const team = state.teams[teamIndex];
      if (team) {
        team.damage += damage;
        state.hp = Math.max(0, state.hp - damage);
        if (Boolean(body.advanceRunner)) {
          team.runnerCount = 6;
          team.runner = team.runner < 6 ? team.runner + 1 : 1;
        }
        if (body.question && typeof body.question === "object") {
          team.question = body.question;
        }
        if (Array.isArray(body.eliminatedOptions)) {
          team.eliminatedOptions = body.eliminatedOptions;
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
}
