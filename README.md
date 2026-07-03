# System Design Voting

ระบบโหวตคะแนนงานออกแบบระบบ (System Design) สำหรับกิจกรรมที่มีผู้นำเสนอ 10 คน
สร้างตามเอกสาร BR / FR / SRS / DB Design / API Spec / Test Cases ใน `Vote.html`

## คุณสมบัติ
- รอบโหวต (VotingSession) มีสถานะ `draft` → `open` → `closed`
- ประเภทคะแนนที่ตั้งค่าได้ (Wow Factor, Creativity, Technical Depth, Practicality, Presentation Clarity …)
- ให้คะแนน **1–5 ดาว** ต่อประเภท
- ผู้โหวตให้คะแนนผู้นำเสนอได้ทุกคน **รวมถึงตัวเอง** แต่โหวตคนเดิมซ้ำไม่ได้
  (unique constraint ที่ `sessionId, voterId, presenterId`)
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
   *(หรือกดสร้างเอง: สร้าง session → เพิ่มหมวด → เพิ่มผู้นำเสนอครบ 10 → กดเปิดรอบโหวต)*
2. กด **โหลดข้อมูล session** เพื่อดู `Session ID` และ `participantId` ของแต่ละ presenter
3. เปิด Voter UI → กรอก `Session ID` + `Voter ID` (participantId เช่นของ a1) → โหลด ballot → ให้ดาวแล้วส่ง
4. กลับมา Admin UI → **โหลดผลคะแนน** เพื่อดูค่าเฉลี่ยและอันดับ

## API (ตาม spec)
| Method | Path | หน้าที่ |
| --- | --- | --- |
| POST | `/voting-sessions` | สร้างรอบโหวต (status = draft) |
| POST | `/voting-sessions/{id}/categories` | เพิ่มประเภทคะแนน |
| POST | `/voting-sessions/{id}/presenters` | เพิ่มผู้นำเสนอ (สูงสุด 10 คน) |
| POST | `/voting-sessions/{id}/voters` | เพิ่มผู้โหวตที่ไม่ใช่ presenter (ส่วนเสริม) |
| POST | `/voting-sessions/{id}/open` | เปิดรอบโหวต (ต้องมี ≥1 หมวด และ 10 presenters) |
| GET  | `/voting-sessions/{id}/ballot?voterId=` | ดึง ballot + สถานะ voted/not voted |
| POST | `/voting-sessions/{id}/votes` | ส่งคะแนน 1 ชุด |
| GET  | `/voting-sessions/{id}/results` | ผลคะแนน + อันดับ |
| POST | `/voting-sessions/{id}/close` | ปิดรอบโหวต |

รหัสข้อผิดพลาดหลัก: `409` โหวตซ้ำ, `403` รอบโหวตไม่เปิด, `400` คะแนนไม่ครบ/นอกช่วง หรือ presenter ไม่อยู่ในรอบ

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
# Vote
