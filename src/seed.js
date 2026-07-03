import { createDb } from './db.js';
import { createService } from './service.js';

/**
 * Seed a ready-to-use "open" session: 5 score categories and 10 presenters (a1..a10),
 * each of whom is also a voter. Run with `npm run seed`.
 */
const CATEGORIES = [
  { name: 'Wow Factor', description: 'ความน่าประทับใจและความโดดเด่นของแนวคิด', displayOrder: 1 },
  { name: 'Creativity', description: 'ความคิดสร้างสรรค์ของการออกแบบ', displayOrder: 2 },
  { name: 'Technical Depth', description: 'ความลึกและความถูกต้องเชิงเทคนิค', displayOrder: 3 },
  { name: 'Practicality', description: 'นำไปใช้งานได้จริงเพียงใด', displayOrder: 4 },
  { name: 'Presentation Clarity', description: 'ความชัดเจนในการนำเสนอ', displayOrder: 5 },
];

const db = createDb(process.env.DB_FILE || 'voting.db');
const service = createService(db);

const session = service.createSession({ name: 'System Design Vote — Today', eventDate: new Date().toISOString().slice(0, 10) });
for (const c of CATEGORIES) service.addCategory(session.id, c);

for (let i = 1; i <= 10; i++) {
  service.addPresenter(session.id, {
    participantCode: `a${i}`,
    displayName: `Presenter A${i}`,
    presentationOrder: i,
    topicTitle: `System Design Topic ${i}`,
  });
}

service.openSession(session.id);

const ballot = service.getBallot(session.id, 'seed-preview');
console.log('Seed complete.');
console.log('  Session ID:', session.id, '(status: open)');
console.log('  Join code :', session.joinCode, '  <-- voters enter only this on the voter page');
console.log('  Categories:', ballot.categories.map((c) => c.name).join(', '));
console.log('  Presenters:', ballot.presenters.map((p) => p.code).join(', '));
db.close();
