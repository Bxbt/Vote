# System Design Voting

ระบบโหวตคะแนนงานออกแบบระบบ (System Design) สำหรับกิจกรรมที่มีผู้นำเสนอหลายคน
สร้างตามเอกสาร BR / FR / SRS / DB Design / API Spec / Test Cases ใน `Vote.html`

## คุณสมบัติ
- รอบโหวต (VotingSession) มีสถานะ `draft` → `open` → `closed`
- ประเภทคะแนนที่ตั้งค่าได้ (Wow Factor, Creativity, Technical Depth, Practicality, Presentation Clarity …)
- ให้คะแนน **1–5 ดาว** ต่อประเภท
- **ผู้นำเสนอเพิ่มได้ไม่จำกัด** (อย่างน้อย 1 คนก็เปิดโหวตได้)
- **ผู้โหวตเข้าร่วมด้วย session code อย่างเดียว** — ระบบสร้าง identity ต่ออุปกรณ์และจำใน `localStorage`
  (เหมาะกับผู้ชม walk-in จำนวนมาก เช่น 30–50 คน โดยไม่ต้องลงทะเบียนล่วงหน้า)
- ผู้โหวตให้คะแนนผู้นำเสนอได้ทุกคน **รวมถึงตัวเอง** แต่โหวตคนเดิมซ้ำไม่ได้
  (unique constraint ที่ `sessionId, voterId, presenterId`)
- **แก้ไข/ลบ ประเภทคะแนนและผู้นำเสนอได้** ภายหลัง (ลบไม่ได้ถ้ามีโหวตอ้างอิงแล้ว)
- ตรวจสอบฝั่ง server เสมอ: session เปิดอยู่, presenter อยู่ในรอบ, คะแนนครบทุกประเภทและอยู่ในช่วง 1–5
- สรุปผล: คะแนนเฉลี่ยรายประเภท, คะแนนเฉลี่ยรวม, จำนวนโหวต และอันดับ (รองรับ tie)

## Stack
Node.js + Express + SQLite (better-sqlite3) · Frontend เป็น HTML/CSS/JS ล้วน · เทสต์ด้วย `node:test`

## เริ่มใช้งาน
```bash
npm install
npm test              # รันเทสต์ครอบคลุม TC-1..TC-14
npm run seed          # (ไม่บังคับ) สร้าง session ตัวอย่าง + 10 presenters แล้วเปิดโหวต
npm start             # เปิดเซิร์ฟเวอร์ที่ http://localhost:3000
```

- Voter UI: <http://localhost:3000/>
- Admin UI: <http://localhost:3000/admin.html>

### วิธีใช้แบบเร็ว
1. เปิด Admin UI → กด **Seed ตัวอย่าง** (สร้าง 5 หมวด + a1..a10 และเปิดโหวตให้เลย)
   *(หรือกดสร้างเอง: สร้าง session → เพิ่มหมวด → เพิ่มผู้นำเสนอ (กี่คนก็ได้) → กดเปิดรอบโหวต)*
2. กด **โหลดข้อมูล session** → จะเห็น **รหัสเข้าห้อง (join code)** ตัวใหญ่ ให้แชร์โค้ดนี้กับผู้โหวต
   *(ในหน้านี้ยังแก้ชื่อ/ลำดับ/ลบ ประเภทคะแนนและผู้นำเสนอได้)*
3. เปิด Voter UI → ผู้โหวต **กรอกแค่ join code** (+ ชื่อไม่บังคับ) → เข้าห้อง → ให้ดาวแล้วส่ง
4. กลับมา Admin UI → **โหลดผลคะแนน** เพื่อดูค่าเฉลี่ยและอันดับ

## API
| Method | Path | หน้าที่ |
| --- | --- | --- |
| POST | `/voting-sessions` | สร้างรอบโหวต (status = draft, ได้ `joinCode` มาด้วย) |
| POST | `/voting-sessions/{id}/categories` | เพิ่มประเภทคะแนน |
| PATCH | `/voting-sessions/{id}/categories/{catId}` | แก้ไขประเภทคะแนน (ชื่อ/คำอธิบาย/ลำดับ/isActive) |
| DELETE | `/voting-sessions/{id}/categories/{catId}` | ลบประเภทคะแนน (บล็อกถ้ามีคะแนนแล้ว) |
| POST | `/voting-sessions/{id}/presenters` | เพิ่มผู้นำเสนอ (ไม่จำกัดจำนวน) |
| PATCH | `/voting-sessions/{id}/presenters/{presenterId}` | แก้ไขผู้นำเสนอ (ชื่อ/ลำดับ/หัวข้อ) |
| DELETE | `/voting-sessions/{id}/presenters/{presenterId}` | ลบผู้นำเสนอ (บล็อกถ้ามีโหวตแล้ว) |
| GET  | `/voting-sessions/by-code/{code}` | resolve join code → session |
| POST | `/voting-sessions/{id}/join` | ผู้โหวต self-register (คืน `voterId` สำหรับจำในอุปกรณ์) |
| POST | `/voting-sessions/{id}/open` | เปิดรอบโหวต (ต้องมี ≥1 หมวด และ ≥1 presenter) |
| GET  | `/voting-sessions/{id}/ballot?voterId=` | ดึง ballot + สถานะ voted/not voted |
| POST | `/voting-sessions/{id}/votes` | ส่งคะแนน 1 ชุด |
| GET  | `/voting-sessions/{id}/results` | ผลคะแนน + อันดับ |
| POST | `/voting-sessions/{id}/close` | ปิดรอบโหวต |

รหัสข้อผิดพลาดหลัก: `409` โหวตซ้ำ / ลบของที่มีข้อมูลอ้างอิง, `403` รอบโหวตไม่เปิด, `400` คะแนนไม่ครบ/นอกช่วง หรือ presenter ไม่อยู่ในรอบ

> หมายเหตุ identity: กติกา "1 โหวต/ผู้นำเสนอ" บังคับต่อ **อุปกรณ์** (จำ `voterId` ใน `localStorage`) — เคลียร์ cache หรือเปลี่ยนเบราว์เซอร์จะได้ identity ใหม่

## โครงสร้าง
```
src/
  db.js         schema + การเชื่อมต่อ SQLite (ตาราง + index + constraint)
  service.js    business logic ทั้งหมด (FR-1..FR-14) — validation, duplicate guard, ranking
  server.js     Express routes ตาม API spec
  seed.js       สร้างข้อมูลตัวอย่าง
public/         Voter UI + Admin UI
test/           voting.test.js — TC-1..TC-14
```

## Deploy (Docker / Portainer + Cloudflare Tunnel)

Production รันเป็น **Git stack** บน Portainer (host clone repo แล้ว build image เอง) และเปิดเว็บที่
**https://vote.bboybezz.xyz** ผ่าน **Cloudflare Tunnel** (cloudflared sidecar ในตัว stack)

ไฟล์: `Dockerfile` (multi-stage, non-root, healthcheck), `docker-compose.yml`, `.dockerignore`
- `vote` — แอป Node/Express (ไม่ publish host port — เข้าผ่าน tunnel เท่านั้น)
- `cloudflared` — เชื่อม Cloudflare Tunnel → `http://vote:3000` ผ่าน network ภายในของ stack
- SQLite เก็บใน named volume `vote-data` ที่ `/data` (คงอยู่ข้าม redeploy)

### ขั้นตอน
1. **Portainer → Stacks → Add stack → Git repository**
   - Repository URL: `https://github.com/Bxbt/Vote` · Reference: `refs/heads/main` · Compose path: `docker-compose.yml`
2. **Environment variable** (ในหน้า Add stack): `TUNNEL_TOKEN` = tunnel token ของ `vote.bboybezz.xyz`
   *(เก็บใน Portainer เท่านั้น — ไม่อยู่ใน repo)*
3. **Cloudflare (Zero Trust → Tunnels)**: public hostname `vote.bboybezz.xyz` → service `http://vote:3000`
4. Deploy — Portainer จะ build + รัน `vote` และ `vote-cloudflared`

ตัวแปรที่ปรับได้: `TUNNEL_TOKEN` (จำเป็น), `VOTE_IMAGE` (ใช้ image จาก registry แทนการ build)
