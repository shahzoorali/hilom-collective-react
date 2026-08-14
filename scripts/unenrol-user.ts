import { MoodleClient } from '../backend/src/lib/moodle.js';

const token = process.env.MOODLE_WS_TOKEN!;
const email = process.argv[2]!;
const courseId = Number(process.argv[3]);
const m = new MoodleClient(token);
const u = await m.getUserByEmail(email);
if (!u) { console.log('user not found'); process.exit(1); }
await m.unenrolUser(u.id, [courseId]);
console.log(`unenrolled user ${u.id} from course ${courseId}`);
