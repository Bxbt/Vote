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
- Admin UI: <http://localhost:3000/admin/> — **ต้องผ่าน Cloudflare Access**

`/admin` ปิดตายเสมอถ้าไม่ได้ตั้ง `CF_ACCESS_TEAM_DOMAIN` และ `CF_ACCESS_AUD` (fail closed)
สำหรับ dev บนเครื่องตัวเองเท่านั้น เปิดด้วย:

```bash
CF_ACCESS_DEV_BYPASS=1 npm start   # /admin ไม่มี auth — ห้ามใช้นอกเครื่อง dev
```

ตัวแปรนี้ถูกเพิกเฉยเมื่อ `NODE_ENV=production` และไม่เปิดให้เองโดยอัตโนมัติ

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
| POST | `/admin/sessions` | สร้างรอบโหวต (status = draft, ได้ `joinCode` มาด้วย) |
| POST | `/admin/sessions/{id}/categories` | เพิ่มประเภทคะแนน |
| PATCH | `/admin/sessions/{id}/categories/{catId}` | แก้ไขประเภทคะแนน (ชื่อ/คำอธิบาย/ลำดับ/isActive) |
| DELETE | `/admin/sessions/{id}/categories/{catId}` | ลบประเภทคะแนน (บล็อกถ้ามีคะแนนแล้ว) |
| POST | `/admin/sessions/{id}/presenters` | เพิ่มผู้นำเสนอ (ไม่จำกัดจำนวน) |
| PATCH | `/admin/sessions/{id}/presenters/{presenterId}` | แก้ไขผู้นำเสนอ (ชื่อ/ลำดับ/หัวข้อ) |
| DELETE | `/admin/sessions/{id}/presenters/{presenterId}` | ลบผู้นำเสนอ (บล็อกถ้ามีโหวตแล้ว) |
| GET  | `/voting-sessions/by-code/{code}` | resolve join code → session |
| POST | `/voting-sessions/{id}/join` | ผู้โหวต self-register (คืน `voterId` สำหรับจำในอุปกรณ์) |
| POST | `/admin/sessions/{id}/open` | เปิดรอบโหวต (ต้องมี ≥1 หมวด และ ≥1 presenter) |
| GET  | `/voting-sessions/{id}/ballot?voterId=` | ดึง ballot + สถานะ voted/not voted |
| POST | `/voting-sessions/{id}/votes` | ส่งคะแนน 1 ชุด |
| GET  | `/admin/sessions/{id}/results` | ผลคะแนน + อันดับ |
| POST | `/admin/sessions/{id}/close` | ปิดรอบโหวต |

รหัสข้อผิดพลาดหลัก: `409` โหวตซ้ำ / ลบของที่มีข้อมูลอ้างอิง, `403` รอบโหวตไม่เปิด, `400` คะแนนไม่ครบ/นอกช่วง หรือ presenter ไม่อยู่ในรอบ

> หมายเหตุ identity: กติกา "1 โหวต/ผู้นำเสนอ" บังคับต่อ **อุปกรณ์** (จำ `voterId` ใน `localStorage`) — เคลียร์ cache หรือเปลี่ยนเบราว์เซอร์จะได้ identity ใหม่

## โครงสร้าง
```
src/
  db.js         schema + การเชื่อมต่อ SQLite (ตาราง + index + constraint)
  service.js    business logic ทั้งหมด (FR-1..FR-14) — validation, duplicate guard, ranking
  server.js     Express routes + path guard + Access gate
  cf-access.js  ตรวจ Cloudflare Access JWT (RS256 + JWKS) ด้วย node:crypto ล้วน
  seed.js       สร้างข้อมูลตัวอย่าง
public/         Voter UI (static root — เปิดสาธารณะทั้งหมด)
admin-ui/       Admin UI — อยู่นอก static root โดยเจตนา เสิร์ฟผ่าน /admin ที่ผ่าน auth แล้วเท่านั้น
test/
  voting.test.js         TC-1..TC-14 (business logic)
  cf-access.test.js      การตรวจ JWT: signature, iss, aud, exp, alg confusion, JWKS
  admin-boundary.test.js HTTP regression ของขอบเขต /admin (SEC-14)
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

ตัวแปรที่ปรับได้: `TUNNEL_TOKEN` (จำเป็น), `CF_ACCESS_TEAM_DOMAIN` + `CF_ACCESS_AUD` (**จำเป็น** ไม่งั้น `/admin` ปิดตาย — ดู SEC-14 ด้านล่าง), `VOTE_IMAGE` (ใช้ image จาก registry แทนการ build)

> **หมายเหตุด้านความปลอดภัย (SEC-13):** endpoint ฝั่งผู้ดูแลทั้งหมดอยู่ใต้ `/admin` ส่วน endpoint ของผู้โหวต (`by-code`, `join`, `ballot`, `votes`) เปิดสาธารณะโดยตั้งใจ — **อย่าย้าย path เหล่านั้น** หน้าโหวตเรียกอยู่ตรงๆ

---

## ความปลอดภัยของขอบเขต /admin (SEC-14)

### ปัญหาเดิม
Cloudflare Access จับคู่ policy จาก **raw path** ส่วน `express.static` จะ **decode** path ก่อนหาไฟล์
`/admin%2f` จึงเป็นคนละ path ในสายตา Access (ไม่ตรง `/admin`) แต่ถอดเป็น `/admin/` ในสายตา static
ผลคือ `GET /admin%2f` ได้ `301 Location: /admin%2f/` แล้ว `/admin%2f/` เสิร์ฟหน้า Admin UI ออกมา
จัดเป็น **CWE-647 (Use of Non-Canonical URL Paths for Authorization Decisions) / OWASP A01** ระดับ Low
(ยืนยันแล้วว่ารั่วเฉพาะ Admin UI — Admin API ไม่ถูก bypass เพราะ Express Router จับคู่จาก raw path เหมือน Access)

นี่ไม่ใช่ช่องโหว่ของ Express — dependency ทั้งหมดเป็นรุ่นปัจจุบัน (express 4.22.2, send 0.19.2,
serve-static 1.16.3, path-to-regexp 0.1.13, qs 6.16.0) เป็น **canonicalization / configuration mismatch** ล้วนๆ

### ที่แก้ไปแล้วฝั่ง origin (defense in depth 3 ชั้น)
1. **Admin UI ย้ายออกจาก static root** — อยู่ที่ `admin-ui/` ไม่ใช่ `public/admin/`
   `express.static(public)` จึงไปไม่ถึงไม่ว่าจะ encode path แบบไหน
2. **Path guard เป็น middleware ตัวแรกสุด** — ตรวจ `req.originalUrl` ดิบ แล้วตอบ `400` ทันทีเมื่อเจอ
   `%2f` `%2F` `%5c` `%5C` `%25` (double encoding เช่น `%252f`) literal backslash หรือ percent-encoding ที่ผิดรูป
   ตอบเป็น JSON ไม่ redirect ไม่ส่ง HTML/JS และ **ไม่ decode ซ้ำแล้วเอาผลไป authorize**
3. **Authorization ที่ชั้นแอป** — ตรวจ `Cf-Access-Jwt-Assertion` (fallback: cookie `CF_Authorization`)
   ด้วย public key จาก `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`
   ตรวจ signature (RS256 เท่านั้น) + `iss` + `aud` + `exp`/`nbf`/`iat` ก่อนเสิร์ฟทั้ง **UI และ API**
   ไม่เชื่อเพียงว่ามี header

ตั้งค่าด้วย env vars:

| ตัวแปร | ค่า |
|---|---|
| `CF_ACCESS_TEAM_DOMAIN` | เช่น `yourteam.cloudflareaccess.com` |
| `CF_ACCESS_AUD` | Application Audience (AUD) tag ของ Access application |
| `CF_ACCESS_DEV_BYPASS` | `1` = ปิด auth (dev เท่านั้น ถูกเพิกเฉยเมื่อ `NODE_ENV=production`) |

ถ้าตัวแปรหาย/ผิด → `/admin` ตอบ `403` ให้ทุกคน (**fail closed**) และ log บรรทัด `SECURITY:` ตอน start

### ยังต้องทำด้วยมือบน Cloudflare (ยังไม่ได้ทำให้)
การแก้ฝั่ง origin ทำให้ปลอดภัยแม้ Access ถูก bypass แต่ควรอุดที่ edge ด้วย:

1. **Normalize หรือ block encoded slash ก่อน Access ประเมิน policy**
   ตั้ง Transform Rule ให้ normalize URL ที่ขา incoming (หรือ WAF custom rule block `%2f`/`%5c` ใน path)
   <https://developers.cloudflare.com/rules/transform/examples/normalize-encoded-slash/>
2. **ตรวจว่า Access policy ครอบ `/admin` และ descendant ทุกระดับ**
   path ของ Access application จับคู่แบบ prefix บน raw path — ยืนยันว่า `/admin`, `/admin/`,
   `/admin/sessions/...` อยู่ในขอบเขตเดียวกันทั้งหมด
   <https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/>
3. **ระยะยาว: แยก Admin ไป hostname เฉพาะ** เช่น `admin-vote.bboybezz.xyz` แล้วให้ Access ครอบทั้ง hostname
   การ match ระดับ hostname ไม่มีปัญหา path canonicalization เลย
4. **อ้างอิงวิธี validate JWT** ที่ implement ไว้ใน `src/cf-access.js`
   <https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/>

### การทดสอบ
`test/admin-boundary.test.js` ยิง HTTP จริงและยืนยันว่าเมื่อไม่มี token ที่ถูกต้อง ทุก variant ต่อไปนี้
ได้เฉพาะ `400/401/403/404` ไม่มี `200` ไม่มี `301` และ body ไม่มี Admin HTML/JS:

```
/admin  /admin/  /admin/index.html  /admin/admin.js
/admin%2f  /admin%2F/  /admin%252f  /admin%5c  /admin%5Cadmin.js
/admin%2fadmin.js  /admin%2fsessions  /admin\admin.js  /admin%2e%2e%2f  /admin%zz
```

พร้อมกับยืนยันว่า token ที่ถูกต้องยังเข้า Admin UI/API ได้ครบ GET/POST/PATCH/DELETE
และ public voter flow (join by code → ballot → vote) ยังทำงานปกติ
