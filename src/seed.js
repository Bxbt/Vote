import { createDb } from './db.js';
import { createService } from './service.js';

/**
 * Seed a draft session with the score categories used in session-985a2812.
 * No presenters are created — add them manually in the admin UI. Run with `npm run seed`.
 */
const CATEGORIES = [
  { name: '🤯 Wow Factor', description: 'ความน่าประทับใจและความโดดเด่นของแนวคิด', displayOrder: 1 },
  { name: '💡 Creativity', description: 'ความคิดสร้างสรรค์ของการออกแบบ', displayOrder: 2 },
  { name: '🛠️ Practicality', description: 'นำไปใช้งานได้จริงเพียงใด', displayOrder: 4 },
  { name: '🎤 Presentation', description: 'เล่าได้น่าสนใจแค่ไหน', displayOrder: 5 },
];

const db = createDb(process.env.DB_FILE || 'voting.db');
const service = createService(db);

const session = service.createSession({ name: 'System Design Vote', eventDate: new Date().toISOString().slice(0, 10) });
for (const c of CATEGORIES) service.addCategory(session.id, c);

console.log('Seed complete (categories only — add presenters, then open the session).');
console.log('  Session ID:', session.id, '(status: draft)');
console.log('  Join code :', session.joinCode);
console.log('  Categories:', CATEGORIES.map((c) => c.name).join(', '));
db.close();
