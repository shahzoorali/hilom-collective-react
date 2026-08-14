import { MoodleClient } from '../backend/src/lib/moodle.js';

const userId = Number(process.argv[2]);
const m = new MoodleClient(process.env.MOODLE_WS_TOKEN!);
const courses = await m.getUserCourses(userId);
console.log(courses.map((c) => `${c.id} ${c.shortname}`).join('\n') || '(no courses)');
