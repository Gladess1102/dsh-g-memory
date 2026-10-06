/**
 * The three tools this plugin registers, kept out of the mount function.
 *
 * Each factory takes exactly what its tool closes over, so the mount function
 * stays a wiring list instead of a 600-line body: the recall tool needs the
 * retrieval helper built there, and the note and forget tools need the context
 * for logging plus the embedding config for the note's vector.
 *
 * SPDX-License-Identifier: MIT
 */

import { cardEntries, defaultCardPath, parseCard, readCards, rewriteCards, withVector, writeCards } from './cards.mjs';
import { embedBatch, resolveConfig } from './embedder.mjs';
import { cardState, overlapSuggestions, resolveRef } from './governance.mjs';
import { renderRecall } from './inject.mjs';
import { prepareQueryVector } from './store.mjs';
import { record } from './telemetry.mjs';
import { l2Normalize } from './vector.mjs';

/** Longest query the tools embed; longer input is truncated rather than rejected. */
export const MAX_QUERY_CHARS = 500;

function parseExpiry(value) {
  const raw = String(value ?? '').trim();
  if (raw === '') return 0;
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (dateOnly) {
    // End of that day, local time: "expires 2026-10-31" should not lapse at 00:00.
    const parsed = new Date(`${raw}T23:59:59`);
    return Number.isFinite(parsed.getTime()) ? parsed.getTime() : 0;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

  /**
   * The write path.
   *
   * Every other way a memory entered this system was a byproduct: a fragment
   * sliced out of a finished transcript, or a card distilled from one. Neither
   * can carry a judgement formed *while the session is still running*, because
   * both run after it ends — consolidation is gated on idle time by design.
   *
   * That gap was found the hard way. A lesson learned mid-session ("the
   * auto-generated cases are semantically invalid, do not use them") reached a
   * following session by no route at all: not the index (built before), not a
   * card (written at handoff, and by then I recorded state rather than
   * judgement), not the handoff file. A later session rebuilt the very thing the
   * lesson warned against. The information did not degrade or get overlooked; it
   * had nowhere to go.
   *
   * The tool exists so that "nowhere to go" stops being true. It costs one
   * embedding call — about 29 ms, no model invocation, because the caller *is*
   * the model.
   */
export function createNoteTool({ ctx, embed }) {
  return {
    name: 'memory_note',
    description:
      'Write one durable memory card for future sessions. Use it the moment you reach a '
      + 'conclusion that a later session would need and could not re-derive: a judgement, '
      + 'an approach you REJECTED and why, a pitfall with its symptom, a decision and its '
      + 'reason. Do NOT use it for facts already visible in the code or the transcript — '
      + 'those are indexed automatically. The value here is judgement, not data. Write it '
      + 'self-contained: assume the reader has not seen this conversation.',
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description:
            'The memory, self-contained and under 600 characters. State what was concluded '
            + 'or rejected, and why. Avoid "above", "earlier", "this session".',
        },
        tags: {
          type: 'string',
          description: 'Optional comma-separated stable tags, e.g. "memory, benchmark".',
        },
        supersedes: {
          type: 'string',
          description:
            'Optional. The id — or an id prefix, or a distinctive fragment of the summary — of an '
            + 'existing memory that this one replaces. Use it whenever a new conclusion corrects or '
            + 'updates an older one: the older card is marked superseded and stops being injected as '
            + 'a fact, while staying readable as the correction trail.',
        },
        expires: {
          type: 'string',
          description:
            'Optional. A date (YYYY-MM-DD) after which this memory should no longer be treated as '
            + 'current — for a status or measurement that is expected to change.',
        },
      },
      required: ['text'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          stored: { type: 'boolean' },
          reason: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          // Declared, not merely returned. `duplicate` was in the result from the
          // day it was written and absent from this schema, so the tool boundary
          // dropped it and the model was never told the memory already existed.
          duplicate: { type: 'boolean' },
          superseded: { type: 'string' },
          supersedeFailed: { type: 'string' },
          overlaps: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                similarity: { type: 'number' },
                preview: { type: 'string' },
              },
              required: ['id'],
              additionalProperties: false,
            },
          },
        },
        required: ['stored'],
        additionalProperties: false,
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.stored
          ? `Noted for future sessions. Tags: ${(value.tags ?? []).join(', ') || 'none'}`
          : `Not stored: ${value.reason ?? 'unknown reason'}`,
      }],
    },
    async execute(args) {
      const raw = String(args?.text ?? '').trim();
      if (raw.length < 20) return { stored: false, reason: 'too short to be a memory' };
      const tagList = String(args?.tags ?? '')
        .split(/[,，、]+/).map((t) => t.trim()).filter(Boolean).slice(0, 8);
      // The Tag line is reconstructed so parseCard applies the same normalisation
      // and limits as the distilled path — one card format, two ways in.
      const parsed = parseCard(
        tagList.length > 0 ? `${raw}\nTag: ${tagList.join(', ')}` : raw,
        { session: `note/${new Date().toISOString().slice(0, 10)}`, time: Date.now() },
      );
      if (parsed === null) return { stored: false, reason: 'nothing worth storing' };
      const expiry = parseExpiry(args?.expires);
      const card = expiry > 0 ? { ...parsed, expires: expiry } : parsed;
      const [vector] = await embedBatch([card.summary], resolveConfig(embed));
      const storePath = defaultCardPath();
      const result = await writeCards([withVector(card, vector)], storePath);
      // `stored: true` used to be returned without checking anything: the write
      // could refuse the card (a refusal-shaped note), fail on disk, or be lost to
      // a concurrent writer, and the model would still be told the memory was
      // saved — after which it stops carrying the fact. Verify it landed.
      if (result.duplicates > 0 && result.added === 0) {
        return { stored: true, duplicate: true, reason: 'already remembered: the same content is in the store' };
      }
      if (result.added === 0) {
        return { stored: false, reason: 'not stored: the text reads as a non-answer rather than a memory' };
      }
      const persisted = (await readCards(storePath).catch(() => [])).some((c) => c.id === card.id);
      if (!persisted) return { stored: false, reason: 'not stored: the write did not persist' };
      ctx.logger?.debug?.(`[dsh-g-memory] noted ${card.summary.length} chars, tags ${card.tags.join(',')}`);

      // Governance. A new memory may replace an older one, but only the writer can
      // say so: two memories that merely resemble each other are not a correction,
      // and an automatic supersede would be unrecoverable. An explicit `supersedes`
      // is applied; otherwise the near-matches are offered, not acted on.
      const after = await readCards(storePath).catch(() => []);
      const others = after.filter((c) => c.id !== card.id);
      const wanted = String(args?.supersedes ?? '').trim();
      if (wanted !== '') {
        const found = resolveRef(others, wanted);
        if ('card' in found) {
          await writeCards(
            [{ ...found.card, status: 'superseded', supersededBy: card.id, governedAt: Date.now() }],
            storePath,
          );
          record('card-superseded', { old: found.card.id, by: card.id, how: found.how });
          ctx.logger?.debug?.(`[dsh-g-memory] superseded ${found.card.id.slice(0, 8)} with ${card.id.slice(0, 8)}`);
          return { stored: true, tags: card.tags, superseded: found.card.id };
        }
        return {
          stored: true,
          tags: card.tags,
          supersedeFailed: 'ambiguous' in found
            ? `several memories match: ${found.ambiguous.slice(0, 3).map((c) => c.id.slice(0, 8)).join(', ')}`
            : 'no memory matched that reference',
        };
      }
      const overlaps = overlapSuggestions(others, l2Normalize(Float32Array.from(vector)))
        .map((hit) => ({
          id: hit.card.id,
          similarity: Number(hit.similarity.toFixed(3)),
          preview: String(hit.card.summary).slice(0, 120),
        }));
      return { stored: true, tags: card.tags, ...(overlaps.length > 0 ? { overlaps } : {}) };
    },
  };
}

/** Retire or hard-delete one memory; retirement keeps the card as evidence. */
export function createForgetTool({ ctx, embed }) {
  return {
    name: 'memory_forget',
    description:
      'Withdraw or delete a durable memory. Use it when a stored memory is wrong, obsolete, or '
      + 'should not be kept — including when the user asks you to forget something. Retiring is the '
      + 'default: the card is kept as evidence and stops being injected as a fact. Pass `hard: true` '
      + 'only to remove it from the store entirely, which cannot be undone.',
    parameters: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Card id, id prefix, or a distinctive fragment of its summary.',
        },
        query: {
          type: 'string',
          description:
            'Used when the id is unknown: the best matching memory is chosen by the same retrieval '
            + 'path recall uses. The response names the card it matched.',
        },
        hard: {
          type: 'boolean',
          description: 'Delete the card instead of retiring it. Cannot be undone.',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          forgotten: { type: 'boolean' },
          hard: { type: 'boolean' },
          id: { type: 'string' },
          preview: { type: 'string' },
          reason: { type: 'string' },
          candidates: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                preview: { type: 'string' },
                state: { type: 'string' },
              },
              required: ['id'],
              additionalProperties: false,
            },
          },
        },
        required: ['forgotten'],
        additionalProperties: false,
      },
      render: (_args, value) => {
        const v = /** @type {any} */ (value);
        if (!v?.forgotten) {
          const list = (v?.candidates ?? []).map((c) => `${c.id.slice(0, 8)} — ${c.preview}`).join('\n');
          return [{ type: 'text', text: `${v?.reason ?? 'nothing was changed'}${list ? `\n${list}` : ''}` }];
        }
        return [{
          type: 'text',
          text: v.hard
            ? `Deleted from memory: ${v.preview}`
            : `Withdrawn from memory (kept as evidence): ${v.preview}`,
        }];
      },
    },
    isConcurrencySafe: () => false,
    timeoutMs: 60_000,
    execute: async (rawArgs) => {
      const args = /** @type {{ id?: string, query?: string, hard?: boolean }} */ (rawArgs || {});
      const storePath = defaultCardPath();
      const cards = await readCards(storePath).catch(() => []);
      if (cards.length === 0) return { forgotten: false, reason: 'no memories are stored' };

      const row = (card) => ({
        id: card.id,
        preview: String(card.summary).slice(0, 120),
        state: cardState(card),
      });

      let target = null;
      let how = 'id';
      const ref = String(args.id ?? '').trim();
      if (ref !== '') {
        const found = resolveRef(cards, ref);
        if ('ambiguous' in found) {
          return { forgotten: false, reason: 'that reference matches several memories', candidates: found.ambiguous.slice(0, 5).map(row) };
        }
        if (!('card' in found)) return { forgotten: false, reason: 'no memory matched that reference' };
        target = found.card;
        how = found.how;
      } else {
        const query = String(args.query ?? '').slice(0, MAX_QUERY_CHARS).trim();
        if (query === '') return { forgotten: false, reason: 'name a memory by id, or give a query' };
        const [vector] = await embedBatch([query], resolveConfig(embed));
        const hits = cardEntries(cards, prepareQueryVector(vector), { includeInactive: true, limit: 3 });
        if (hits.length === 0) return { forgotten: false, reason: 'no memory matched that query' };
        target = cards.find((c) => c.id === hits[0].cardId) ?? null;
        how = 'query';
        if (target === null) return { forgotten: false, reason: 'no memory matched that query' };
      }

      const hard = args.hard === true;
      if (hard) await rewriteCards(cards.filter((c) => c.id !== target.id), storePath);
      else await writeCards([{ ...target, status: 'retired', governedAt: Date.now() }], storePath);
      record(hard ? 'card-forgotten' : 'card-retired', { id: target.id, how });
      ctx.logger?.debug?.(`[dsh-g-memory] ${hard ? 'deleted' : 'retired'} card ${target.id.slice(0, 8)} (by ${how})`);
      return { forgotten: true, hard, id: target.id, preview: String(target.summary).slice(0, 120) };
    },
  };
}

/** The model-facing recall tool; retrieval itself stays in the mount function. */
export function createRecallTool({ maxResults, previewChars, retrieve }) {
  return {
    name: 'memory_recall',
    description:
      'Search long-term memory of past sessions for context relevant to the current task. ' +
      'Use it when the user refers to something from an earlier conversation, or when a ' +
      'decision, measurement or error from before may change the answer. Returns short ' +
      'previews with a session locator; read the session log for full text.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'What to recall, phrased as a question or a topic.',
        },
        limit: {
          // `enum` rather than `minimum`/`maximum`: the Harness schema subset is
          // type/oneOf/properties/required/additionalProperties/items/enum/const
          // plus annotations, and an unsupported keyword makes register() throw
          // — which silently costs the whole tool. Enumerating the accepted
          // values constrains the model at least as tightly.
          type: 'integer',
          description: `How many memories to return (1-${maxResults}).`,
          enum: Array.from({ length: maxResults }, (_, i) => i + 1),
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          found: { type: 'integer' },
          synthesis: {
            type: 'string',
            description: 'Condensed answer assembled from the matched memories; empty when unavailable.',
          },
          memories: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                preview: { type: 'string' },
                role: { type: 'string' },
                when: { type: 'string' },
                session: { type: 'string' },
                seq: { type: 'integer' },
                score: { type: 'number' },
                // Provenance has to travel with the entry through the tool boundary
                // too. Without these two the renderer rebuilt every entry as an
                // anonymous excerpt, so a card the user wrote was presented to the
                // model as "verbatim, checkable against its source" — the exact
                // over-claim the labels exist to prevent.
                source: { type: 'string' },
                orphaned: { type: 'boolean' },
                // Governance travels too: an entry that is superseded, expired or
                // withdrawn must arrive labelled, or the model reads a corrected
                // fact as the current one.
                state: { type: 'string', enum: ['active', 'expired', 'superseded', 'retired'] },
                stateNote: { type: 'string' },
                supersededBy: { type: 'string' },
              },
              required: ['preview', 'role', 'session'],
              additionalProperties: false,
            },
          },
        },
        required: ['found', 'memories'],
        additionalProperties: false,
      },
      render: (_args, value) => {
        const v = /** @type {any} */ (value);
        if (!v || (v.found === 0 && !v.synthesis)) {
          return [{ type: 'text', text: 'No matching memory found.' }];
        }
        // Rendered through the same framed, escaped path as automatic recall.
        // Recalled text is untrusted whoever asked for it, so the tool result
        // carries the notice too — previously it carried none.
        const entries = v.synthesis
          ? [{ role: 'synthesis', source: 'synthesis', text: v.synthesis, time: Date.now(), score: 1 }]
          : v.memories.map((m) => ({
            role: m.role,
            text: m.preview,
            time: Date.parse(m.when) || 0,
            session: m.session,
            seq: m.seq,
            score: m.score,
            // Carried through so provenanceOf() can label it: a card is a written
            // memory, and a unit whose session is gone is not checkable at all.
            source: m.source,
            orphaned: m.orphaned === true,
            // Governance travels into the renderer too, so a memory that is no
            // longer current is labelled as such rather than reading as the latest.
            state: m.state,
            stateNote: m.stateNote,
            supersededBy: m.supersededBy,
          }));
        const rendered = renderRecall(entries);
        return [{ type: 'text', text: rendered || 'No matching memory found.' }];
      },
    },
    isConcurrencySafe: () => true,
    timeoutMs: 60_000,
    execute: async (rawArgs) => {
      const args = /** @type {{ query?: string, limit?: number }} */ (rawArgs || {});
      const query = String(args.query || '').slice(0, MAX_QUERY_CHARS).trim();
      if (!query) return { found: 0, memories: [], synthesis: '' };

      const limit = Math.max(1, Math.min(Number(args.limit) || maxResults, maxResults));
      const result = await retrieve(query, limit);

      return {
        found: result.selected.length,
        synthesis: result.synthesis,
        // Explicitly pick the response fields rather than spreading: spreading
        // would carry anything added to an entry upstream into the result the
        // model sees and the durable log keeps.
        memories: result.selected.map((entry) => ({
          preview: String(entry.text ?? '').slice(0, previewChars),
          role: entry.role,
          when: entry.time > 0 ? new Date(entry.time).toISOString() : '',
          session: entry.session,
          // 卡片（memory_note 写下的记忆）没有会话序号，entry.seq 是 null；而宿主
          // 把 `seq` 声明为 integer 且**非必填** —— 带 null 会让整次 memory_recall
          // 被判为非法输出（value.memories[0].seq must be an integer），所以只在
          // 确实是整数时才带上它。
          ...(Number.isInteger(entry.seq) ? { seq: entry.seq } : {}),
          score: entry.score,
          ...(entry.source ? { source: entry.source } : {}),
          ...(entry.state && entry.state !== 'active'
            ? { state: entry.state, stateNote: entry.stateNote, ...(entry.supersededBy ? { supersededBy: entry.supersededBy } : {}) }
            : {}),
          ...(entry.orphaned === true ? { orphaned: true } : {}),
        })),
      };
    },
  };
}
