// 동국대 도서관 열람실 빈자리 → 카카오톡 "나에게 보내기" 알림 (Cloudflare Worker)
// 조회만 합니다. 예약·취소는 하지 않습니다.
// Cron이 1분마다 실행되고, 한 번 실행할 때 20초 간격으로 3번 확인합니다.
// KV "state": { free, lastSent, libToken, kakaoAccess, kakaoRefresh, errors } — 바뀐 경우에만 기록
// (무료 요금제 KV 쓰기 한도: 하루 1,000회)

const BASE = "https://lib.dongguk.edu/pyxis-api";
const CHECKS_PER_RUN = 3;
const CHECK_GAP_MS = 20_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const watchedSeats = (env) => env.SEATS.split(",").map((s) => s.trim()).filter(Boolean);

function seoulNow() {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })
    .format(new Date());
}

function inQuietHours(env) {
  if (!env.QUIET_HOURS) return false;
  const [start, end] = env.QUIET_HOURS.split("-");
  const t = seoulNow().slice(0, 5);
  return start < end ? t >= start && t < end : t >= start || t < end;
}

async function libRequest(state, env, method, path, payload, retry = true) {
  const headers = { Accept: "application/json", "Content-Type": "application/json;charset=UTF-8", "User-Agent": "Mozilla/5.0" };
  if (state.libToken) headers["pyxis-auth-token"] = state.libToken;
  const res = await fetch(BASE + path, { method, headers, body: payload ? JSON.stringify(payload) : undefined });
  const authFailed = res.status === 401 || res.status === 403;
  const result = authFailed ? null : await res.json();
  if (authFailed || (result && !result.success && String(result.code).startsWith("error.authentication"))) {
    if (retry && path !== "/api/login") {
      await libLogin(state, env);
      return libRequest(state, env, method, path, payload, false);
    }
    throw new Error(`도서관 로그인 실패 (${res.status} ${result?.code ?? ""})`);
  }
  if (!result.success) throw new Error(`도서관 ${result.code}: ${result.message ?? ""}`);
  return result;
}

async function libLogin(state, env) {
  state.libToken = null;
  const result = await libRequest(state, env, "POST", "/api/login",
    { loginId: env.LIB_ID, password: env.LIB_PW, isFamilyLogin: false, isMobile: false }, false);
  state.libToken = result.data.accessToken;
  state.dirty = true;
}

async function freeSeats(state, env) {
  if (!state.libToken) await libLogin(state, env);
  const seats = (await libRequest(state, env, "GET", `/1/api/rooms/${env.ROOM_ID}/seats`)).data.list;
  const free = new Set(seats.filter((s) => s.isActive && s.isOccupied === false).map((s) => s.code));
  return watchedSeats(env).filter((c) => free.has(c));
}

async function kakaoRefresh(state, env) {
  const body = new URLSearchParams({ grant_type: "refresh_token", client_id: env.KAKAO_REST_KEY, refresh_token: state.kakaoRefresh });
  if (env.KAKAO_CLIENT_SECRET) body.set("client_secret", env.KAKAO_CLIENT_SECRET);
  const res = await fetch("https://kauth.kakao.com/oauth/token", { method: "POST", body });
  const result = await res.json();
  if (!res.ok) throw new Error(`카카오 토큰 갱신 실패 ${res.status}: ${JSON.stringify(result)}`);
  state.kakaoAccess = result.access_token;
  if (result.refresh_token) state.kakaoRefresh = result.refresh_token; // 만료 1개월 전부터 새로 발급됨
  state.dirty = true;
}

async function kakaoSend(state, env, text, retry = true) {
  const url = env.RESERVE_URL;
  const template = { object_type: "text", text: text.slice(0, 200), link: { web_url: url, mobile_web_url: url }, button_title: "예약하러 가기" };
  const res = await fetch("https://kapi.kakao.com/v2/api/talk/memo/default/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${state.kakaoAccess}` },
    body: new URLSearchParams({ template_object: JSON.stringify(template) }),
  });
  if (res.status === 401 && retry) {
    await kakaoRefresh(state, env);
    return kakaoSend(state, env, text, false);
  }
  if (!res.ok) throw new Error(`카카오 전송 실패 ${res.status}: ${await res.text()}`);
}

async function loadState(env) {
  const state = (await env.STATE.get("state", "json")) ?? {};
  state.free ??= null;
  state.lastSent ??= {};
  state.errors ??= 0;
  state.dirty = false;
  return state;
}

async function saveState(env, state) {
  if (!state.dirty) return;
  const { dirty, ...rest } = state;
  await env.STATE.put("state", JSON.stringify(rest));
}

async function check(state, env) {
  let free;
  try {
    free = await freeSeats(state, env);
  } catch (error) {
    state.libToken = null;
    if (state.errors < 3) {
      state.errors += 1;
      state.dirty = true;
      if (state.errors === 3) await kakaoSend(state, env, `⚠️ 빈자리 감시 오류: ${error.message}`).catch(() => {});
    }
    console.log("check failed:", error.message);
    return;
  }
  if (state.errors) { state.errors = 0; state.dirty = true; }

  const cooldown = Number(env.SEAT_COOLDOWN_MINUTES ?? 5) * 60_000;
  const now = Date.now();
  if (state.free === null) {
    state.free = free;
    state.dirty = true;
    await kakaoSend(state, env, `📚 ${env.ROOM_NAME} 빈자리 감시 시작\n현재 빈자리: ${free.join(", ") || "없음"}`);
    return;
  }
  const prev = new Set(state.free);
  const newly = free.filter((c) => !prev.has(c) && now - (state.lastSent[c] ?? 0) >= cooldown);
  if (free.join() !== state.free.join()) { state.free = free; state.dirty = true; }
  if (!newly.length || inQuietHours(env)) return;
  await kakaoSend(state, env, `🟢 ${env.ROOM_NAME} 빈자리: ${newly.join(", ")}\n현재 빈자리: ${free.join(", ")}\n(${seoulNow()})`);
  for (const c of newly) state.lastSent[c] = now;
  state.dirty = true;
}

export default {
  async scheduled(_event, env) {
    if (env.ENABLED === "false") return;
    const state = await loadState(env);
    try {
      for (let i = 0; i < CHECKS_PER_RUN; i++) {
        if (i) await sleep(CHECK_GAP_MS);
        await check(state, env);
      }
    } finally {
      await saveState(env, state);
    }
  },

  // GET /status?key=ADMIN_KEY → 조회 1회 결과 (예약 변경 없음)
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.searchParams.get("key") !== env.ADMIN_KEY) return new Response("not found", { status: 404 });
    const state = await loadState(env);
    try {
      const free = await freeSeats(state, env);
      await saveState(env, state);
      return Response.json({ ok: true, room: env.ROOM_NAME, watching: watchedSeats(env), free, enabled: env.ENABLED !== "false", errors: state.errors, at: seoulNow() });
    } catch (error) {
      return Response.json({ ok: false, error: error.message }, { status: 502 });
    }
  },
};
