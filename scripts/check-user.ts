import { MoodleClient } from '../backend/src/lib/moodle.js';

const token = process.env.MOODLE_WS_TOKEN!;
const email = process.argv[2]!;
const m = new MoodleClient(token);
const u = await m.getUserByEmail(email);
console.log(u ? `exists: id=${u.id} auth=${u.auth} username=${u.username}` : 'does not exist yet');
