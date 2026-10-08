// Example API of @@APP_NAME@@ (replace with the app's own): a list of items.
//   GET    /api/items        all items, newest first
//   POST   /api/items        { title } → the new item
//   DELETE /api/items/:id
import { query } from '../core/db.mjs';
import { httpError } from '../core/http.mjs';

export default function items(app) {
  app.get('/api/items', () => query('select id, title, created_at from items order by created_at desc, id desc'));

  app.post('/api/items', async ({ body }) => {
    const title = String(body?.title ?? '').trim();
    if (!title) throw httpError(400, 'title_missing', 'Give the item a title.');
    if (title.length > 200) throw httpError(400, 'title_too_long', 'The title can have at most 200 characters.');
    const [row] = await query('insert into items (title) values ($1) returning id, title, created_at', [title]);
    return { status: 201, body: row };
  });

  app.del('/api/items/:id', async ({ params }) => {
    if (!/^\d+$/.test(params.id)) throw httpError(400, 'bad_id', 'There is no such item.');
    const rows = await query('delete from items where id = $1 returning id', [params.id]);
    if (!rows.length) throw httpError(404, 'not_found', 'There is no such item.');
    return null;
  });
}
