#!/usr/bin/env node
// 대화형 설정: Cloudflare 로그인 → 열람실·좌석 선택 → 도서관 로그인 확인 → 카카오 연결 → 배포 → 동작 확인
// 다시 실행하면 같은 Worker를 새 설정으로 덮어씁니다.

import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LIB = "https://lib.dongguk.edu/pyxis-api";
const REDIRECT = "http://localhost:8765/callback";
const RESERVE_URL = "https://lib.dongguk.edu/mylibrary/seat/reservations";
const isWin = process.platform === "win32";

// ── 입출력 ──────────────────────────────────────────────
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
const lines = rl[Symbol.asyncIterator]();
let muted = false;
const writeOut = rl._writeToOutput.bind(rl);
rl._writeToOutput = (text) => { if (!muted) writeOut(text); }; // 비밀번호 입력을 화면에 표시하지 않음

async function ask(question, { hidden = false, def = "" } = {}) {
  if (rl.closed) process.stdout.write(question); // 입력을 파이프로 넣은 경우
  else { rl.setPrompt(question); rl.prompt(); }
  muted = hidden;
  const { value } = await lines.next();
  muted = false;
  if (hidden) process.stdout.write("\n");
  return (value ?? "").trim() || def;
}
const step = (n, title) => console.log(`\n━━ ${n}. ${title} ━━`);
const fail = (msg) => { console.error(`\n✖ ${msg}`); process.exit(1); };

function wrangler(args, { inherit = false } = {}) {
  const r = spawnSync("npx", ["wrangler", ...args], { cwd: ROOT, encoding: "utf8", shell: isWin, stdio: inherit ? "inherit" : "pipe" });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

// 출력을 화면에 보여주면서 모아둠 (배포 주소를 읽기 위해)
function wranglerTee(args) {
  return new Promise((resolve) => {
    const child = spawn("npx", ["wrangler", ...args], { cwd: ROOT, shell: isWin, stdio: ["inherit", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", (d) => { out += d; process.stdout.write(d); });
    child.on("close", (code) => resolve({ ok: code === 0, out }));
  });
}

function withTempFile(content, fn) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "seat-alert-")), "data.json");
  fs.writeFileSync(file, content, { mode: 0o600 });
  try { return fn(file); } finally { fs.rmSync(path.dirname(file), { recursive: true, force: true }); }
}

// ── 도서관 ──────────────────────────────────────────────
async function libJson(pathname, { token, body } = {}) {
  const headers = { Accept: "application/json", "Content-Type": "application/json;charset=UTF-8", "User-Agent": "Mozilla/5.0" };
  if (token) headers["pyxis-auth-token"] = token;
  const res = await fetch(LIB + pathname, { method: body ? "POST" : "GET", headers, body: body && JSON.stringify(body) });
  return res.json();
}

function parseSeatSpec(spec, valid) {
  const out = [];
  for (const part of spec.split(",").map((s) => s.trim()).filter(Boolean)) {
    const range = part.match(/^([A-Za-z가-힣]*)(\d+)\s*[-~]\s*\1?(\d+)$/);
    if (range) {
      const [, prefix, a, b] = range;
      for (let n = Number(a); n <= Number(b); n++) out.push(`${prefix.toUpperCase()}${n}`);
    } else out.push(part.toUpperCase());
  }
  const unknown = out.filter((c) => !valid.has(c));
  return { seats: [...new Set(out)], unknown };
}

function summarizeCodes(codes) {
  const groups = new Map();
  for (const c of codes) {
    const m = c.match(/^(\D*)(\d+)$/);
    const key = m ? m[1] : c;
    if (!groups.has(key)) groups.set(key, []);
    if (m) groups.get(key).push(Number(m[2]));
  }
  return [...groups].map(([p, ns]) => ns.length ? `${p}${Math.min(...ns)}~${p}${Math.max(...ns)} (${ns.length}석)` : p).join(", ");
}

// ── 카카오 ──────────────────────────────────────────────
function openBrowser(url) {
  const cmd = process.platform === "darwin" ? "open" : isWin ? "start" : "xdg-open";
  spawn(cmd, isWin ? ['""', `"${url}"`] : [url], { shell: isWin, stdio: "ignore", detached: true }).unref();
}

function waitForKakaoCode() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const q = new URL(req.url, REDIRECT).searchParams;
      if (!q.has("code") && !q.has("error")) { res.writeHead(404).end(); return; }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end("인증 완료. 이 창을 닫고 터미널로 돌아가세요.");
      server.close();
      q.has("code") ? resolve(q.get("code")) : reject(new Error(`${q.get("error")}: ${q.get("error_description")}`));
    });
    server.on("error", reject);
    server.listen(8765, "localhost");
  });
}

async function kakaoConnect(restKey, secret) {
  const authUrl = "https://kauth.kakao.com/oauth/authorize?" + new URLSearchParams({ client_id: restKey, redirect_uri: REDIRECT, response_type: "code", scope: "talk_message" });
  console.log("브라우저에서 카카오 로그인 후 '카카오톡 메시지 전송'에 동의하세요.");
  console.log("브라우저에 KOE 오류가 뜨면 README의 '카카오 오류' 표를 보고 고친 뒤 setup을 다시 실행하세요.");
  console.log(`(브라우저가 안 열리면 이 주소를 직접 여세요)\n${authUrl}`);
  const codePromise = waitForKakaoCode();
  openBrowser(authUrl);
  const code = await codePromise;
  const body = new URLSearchParams({ grant_type: "authorization_code", client_id: restKey, redirect_uri: REDIRECT, code });
  if (secret) body.set("client_secret", secret);
  const res = await fetch("https://kauth.kakao.com/oauth/token", { method: "POST", body });
  const tokens = await res.json();
  if (!res.ok) {
    const hint = /KOE010|client_secret/i.test(JSON.stringify(tokens)) ? "\n→ 카카오 콘솔의 Client Secret(카카오 로그인)이 켜져 있습니다. 그 코드를 입력하세요." : "";
    fail(`카카오 토큰 발급 실패: ${JSON.stringify(tokens)}${hint}`);
  }
  if (!String(tokens.scope ?? "").includes("talk_message")) fail("'카카오톡 메시지 전송' 동의가 빠졌습니다. 동의 화면에서 체크한 뒤 다시 실행하세요.");
  const template = { object_type: "text", text: "✅ 도서관 빈자리 알림 연결 테스트", link: { web_url: RESERVE_URL, mobile_web_url: RESERVE_URL }, button_title: "예약하러 가기" };
  const sent = await fetch("https://kapi.kakao.com/v2/api/talk/memo/default/send", {
    method: "POST", headers: { Authorization: `Bearer ${tokens.access_token}` },
    body: new URLSearchParams({ template_object: JSON.stringify(template) }),
  });
  if (!sent.ok) fail(`카카오 테스트 메시지 실패: ${await sent.text()}`);
  console.log("✔ 테스트 메시지를 보냈습니다. 브라우저에서 로그인한 카카오 계정으로 갑니다.");
  if ((await ask("본인 카카오톡에 '연결 테스트' 메시지가 왔나요? (y/N): ")).toLowerCase() !== "y") {
    fail("다른 사람 카카오 계정으로 로그인된 상태입니다. 브라우저에서 카카오(kakao.com)를 로그아웃한 뒤 setup을 다시 실행하세요.");
  }
  return { access: tokens.access_token, refresh: tokens.refresh_token };
}

// ── 메인 ────────────────────────────────────────────────
async function main() {
  if (Number(process.versions.node.split(".")[0]) < 20) fail("Node.js 20 이상이 필요합니다. https://nodejs.org 에서 LTS를 설치하세요.");
  console.log("동국대 도서관 빈자리 카카오톡 알림 설정을 시작합니다. (예약·취소는 하지 않는 알림 전용)");

  step(1, "Cloudflare 로그인");
  let who = wrangler(["whoami"]);
  if (!who.ok || /not authenticated/i.test(who.out)) {
    console.log("브라우저가 열리면 Cloudflare에 로그인하고 Allow를 누르세요.");
    if (!wrangler(["login"], { inherit: true }).ok) fail("Cloudflare 로그인에 실패했습니다.");
    who = wrangler(["whoami"]);
  }
  const email = who.out.match(/email ([^\s]+?)\.?\s/)?.[1];
  console.log(`✔ 로그인됨${email ? `: ${email}` : ""}`);
  if ((await ask("이 Cloudflare 계정이 본인 것이 맞나요? (y/N): ")).toLowerCase() !== "y") {
    console.log("다른 사람 계정입니다. 로그아웃합니다. 본인 계정으로 다시 실행하세요.");
    wrangler(["logout"], { inherit: true });
    process.exit(1);
  }

  step(2, "열람실 선택");
  const rooms = (await libJson("/1/seat-rooms?smufMethodCode=PC&branchGroupId=1")).data.list;
  rooms.forEach((r, i) => console.log(`  ${i + 1}) ${r.branch.name} ${r.name} (${r.floor}층, ${r.seats.total}석)`));
  const roomIdx = Number(await ask("번호를 입력하세요: ")) - 1;
  const room = rooms[roomIdx] ?? fail("목록에 있는 번호를 입력하세요.");

  step(3, "도서관 계정 확인");
  console.log("좌석별 빈자리는 로그인해야 조회됩니다. 비밀번호는 본인 Cloudflare의 암호화된 Secret에만 저장됩니다.");
  const libId = await ask("학번(도서관 아이디): ");
  const libPw = await ask("도서관 비밀번호(입력이 보이지 않음): ", { hidden: true });
  const login = await libJson("/api/login", { body: { loginId: libId, password: libPw, isFamilyLogin: false, isMobile: false } });
  if (!login.success) fail(`도서관 로그인 실패: ${login.message ?? login.code}`);
  const seatList = (await libJson(`/1/api/rooms/${room.id}/seats`, { token: login.data.accessToken })).data.list;
  const valid = new Set(seatList.map((s) => s.code));
  console.log(`✔ 로그인 성공. ${room.name} 좌석: ${summarizeCodes(seatList.map((s) => s.code))}`);

  step(4, "알림 받을 좌석");
  console.log("예) A1-A12   /   A1-A12, B3, B7   /   all (열람실 전체, 알림이 매우 많아질 수 있음)");
  let seats;
  for (;;) {
    const spec = await ask("좌석: ");
    if (spec.toLowerCase() === "all") { seats = seatList.map((s) => s.code); break; }
    const parsed = parseSeatSpec(spec, valid);
    if (parsed.seats.length && !parsed.unknown.length) { seats = parsed.seats; break; }
    console.log(parsed.unknown.length ? `없는 좌석: ${parsed.unknown.join(", ")}` : "좌석을 입력하세요.");
  }
  console.log(`✔ ${seats.length}석 감시: ${seats.length > 20 ? summarizeCodes(seats) : seats.join(", ")}`);
  const quiet = await ask("알림을 끌 시간대 (예: 00:00-07:00, 없으면 Enter): ");
  if (quiet && !/^\d\d:\d\d-\d\d:\d\d$/.test(quiet)) fail("시간대 형식은 HH:MM-HH:MM 입니다.");

  step(5, "카카오톡 연결");
  console.log("README의 '카카오 앱 준비'를 먼저 끝내야 합니다.");
  const restKey = await ask("카카오 REST API 키: ");
  const secret = await ask("카카오 로그인 Client Secret (꺼져 있으면 Enter): ");
  const kakao = await kakaoConnect(restKey, secret);

  step(6, "Cloudflare에 배포");
  const name = (await ask("Worker 이름 (Enter = seat-alert): ", { def: "seat-alert" })).toLowerCase();
  if (!/^[a-z0-9-]{1,50}$/.test(name)) fail("Worker 이름은 영문 소문자·숫자·하이픈만 쓸 수 있습니다.");
  if (wrangler(["deployments", "list", "--name", name]).ok &&
      (await ask(`이 계정에 '${name}' Worker가 이미 있습니다. 새 설정으로 덮어쓸까요? (y/N): `)).toLowerCase() !== "y") {
    fail("중단했습니다. 다른 Worker 이름으로 다시 실행하세요.");
  }
  const kvTitle = `${name}-state`;
  const listed = wrangler(["kv", "namespace", "list"]);
  let kvId = (() => { try { return JSON.parse(listed.out.slice(listed.out.indexOf("["))).find((n) => n.title === kvTitle)?.id; } catch { return undefined; } })();
  if (!kvId) {
    const created = wrangler(["kv", "namespace", "create", kvTitle]);
    kvId = created.out.match(/"?id"?\s*[=:]\s*"([0-9a-f]{32})"/)?.[1];
    if (!kvId) fail(`KV 저장소 생성 실패:\n${created.out}`);
  }
  const toml = `name = "${name}"
main = "src/index.js"
compatibility_date = "2026-10-01"
workers_dev = true

[triggers]
crons = ["* * * * *"]

[vars]
ROOM_ID = "${room.id}"
ROOM_NAME = "${room.name}"
SEATS = "${seats.join(",")}"
RESERVE_URL = "${RESERVE_URL}"
SEAT_COOLDOWN_MINUTES = "5"
QUIET_HOURS = "${quiet}"
ENABLED = "true"

[[kv_namespaces]]
binding = "STATE"
id = "${kvId}"
`;
  fs.writeFileSync(path.join(ROOT, "wrangler.toml"), toml);
  withTempFile(JSON.stringify({ kakaoAccess: kakao.access, kakaoRefresh: kakao.refresh }), (file) => {
    const put = wrangler(["kv", "key", "put", "state", "--path", file, "--namespace-id", kvId, "--remote"]);
    if (!put.ok) fail(`KV 저장 실패:\n${put.out}`);
  });
  const deployed = await wranglerTee(["deploy"]);
  if (!deployed.ok) fail("배포 실패. 처음 쓰는 계정이면 Cloudflare 대시보드 → Workers & Pages에서 workers.dev 서브도메인을 먼저 만든 뒤 다시 실행하세요.");
  const url = deployed.out.match(/https:\/\/[^\s]+\.workers\.dev/)?.[0];
  const adminKey = crypto.randomBytes(18).toString("base64url");
  withTempFile(JSON.stringify({ LIB_ID: libId, LIB_PW: libPw, KAKAO_REST_KEY: restKey, KAKAO_CLIENT_SECRET: secret, ADMIN_KEY: adminKey }), (file) => {
    const put = wrangler(["secret", "bulk", file]);
    if (!put.ok) fail(`Secret 등록 실패:\n${put.out}`);
  });
  fs.writeFileSync(path.join(ROOT, ".admin.json"), JSON.stringify({ worker: name, url, key: adminKey }, null, 2), { mode: 0o600 });

  step(7, "동작 확인");
  if (!url) { console.log("배포 주소를 찾지 못했습니다. 1~2분 뒤 카카오톡에 '감시 시작' 메시지가 오는지 확인하세요."); return; }
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    try {
      const status = await (await fetch(`${url}/status?key=${adminKey}`)).json();
      if (status.ok) {
        console.log(`✔ Cloudflare에서 도서관 조회 성공. 지금 빈자리: ${status.free.join(", ") || "없음"}`);
        console.log("\n완료! 1~2분 안에 카카오톡으로 '빈자리 감시 시작' 메시지가 옵니다.");
        console.log("상태 확인: npm run status   /   끄기: npm run off   /   켜기: npm run on");
        return;
      }
      console.log(`  대기 중… (${status.error})`);
    } catch { console.log("  대기 중…"); }
  }
  fail("Worker가 도서관을 조회하지 못했습니다. `npm run logs`로 오류를 확인하세요.");
}

main().catch((error) => fail(error.message)).finally(() => rl.close());
