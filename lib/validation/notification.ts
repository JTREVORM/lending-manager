/**
 * Validation for the one thing a person can do to a notification: read it.
 *
 * There is nothing else. The stream is append-only, a receipt is insert-only,
 * and `mark_notifications_read` derives the profile from the session — so the
 * only input is *which* notifications, and the only rule is that each one is
 * an identifier.
 */

import { z } from 'zod';

import { uuidSchema } from './common';

/**
 * Marking some, or all.
 *
 * An empty list is not the same as no list: no list means "everything I can
 * see", which is the "mark all read" control, and an empty list would be a
 * request to mark nothing. The schema keeps them distinct rather than
 * collapsing both to null, because collapsing them would make the two
 * controls indistinguishable to the server.
 */
export const markNotificationsReadSchema = z.object({
  ids: z
    .array(uuidSchema)
    // A page shows 25. The ceiling is well above that and well below anything
    // that would make the statement slow.
    .max(200, 'That is more notifications than one request may mark.')
    .nullable()
    .optional()
    .transform((value) => value ?? null),
});

export type MarkNotificationsReadInput = z.infer<typeof markNotificationsReadSchema>;

/** The notifications page's filter. */
export const notificationSearchSchema = z.object({
  group: z
    .union([z.literal(''), z.enum(['decisions', 'collections', 'lending', 'money'])])
    .transform((value) => (value === '' ? null : value))
    .nullable()
    .optional()
    .transform((value) => value ?? null),
  severity: z
    .union([z.literal(''), z.enum(['info', 'attention', 'urgent'])])
    .transform((value) => (value === '' ? null : value))
    .nullable()
    .optional()
    .transform((value) => value ?? null),
  unread: z
    .union([z.literal(''), z.literal('1'), z.literal('0'), z.boolean()])
    .transform((value) => value === '1' || value === true)
    .optional()
    .transform((value) => value ?? false),
  page: z.coerce.number().int().min(1).max(500).catch(1).default(1),
});

export type NotificationSearchInput = z.infer<typeof notificationSearchSchema>;
