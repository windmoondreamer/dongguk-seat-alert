#!/usr/bin/env node
// 배포된 Worker에 조회를 1회 요청해 현재 상태를 보여줍니다 (예약 변경 없음).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".admin.json");
if (!fs.existsSync(file)) { console.error("아직 설정하지 않았습니다. npm run setup 을 먼저 실행하세요."); process.exit(1); }
const { url, key } = JSON.parse(fs.readFileSync(file, "utf8"));
const res = await fetch(`${url}/status?key=${key}`);
const s = await res.json();
if (!s.ok) { console.error(`✖ 조회 실패: ${s.error}`); process.exit(1); }
console.log(`${s.room} | 감시 ${s.watching.length}석 | 알림 ${s.enabled ? "켜짐" : "꺼짐"} | 연속 오류 ${s.errors}회 | ${s.at}`);
console.log(`지금 빈자리: ${s.free.join(", ") || "없음"}`);
