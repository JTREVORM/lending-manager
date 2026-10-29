import { z } from 'zod';

const id = z.uuid();
const date = z.iso.date();
const note = z.string().trim().min(3).max(1000);
const optionalText = z.string().trim().max(1000).optional().default('');
const payment = z.object({
  operation: z.literal('collect_fine'),
  fineId: id,
  amount: z.string().regex(/^[1-9][0-9]*$/).transform(Number).pipe(z.number().int().max(10000000)),
  method: z.enum(['cash', 'mtn_mobile_money', 'airtel_money', 'bank']),
  reference: z.string().trim().max(200).optional().default(''),
  key: id,
}).superRefine((input, ctx) => {
  if ((input.method === 'cash' && input.reference !== '')
      || (input.method !== 'cash' && input.reference.length < 4)) {
    ctx.addIssue({ code: 'custom', path: ['reference'],
      message: input.method === 'cash' ? 'Cash has no network reference.' : 'Enter the network or bank reference.' });
  }
});

export const policyUpdateSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('record_timing'), policyId: id, effectiveDate: date, reference: z.string().trim().min(3).max(200) }),
  z.object({ operation: z.literal('begin_transition'), policyId: id, effectiveDate: date, note }),
  z.object({ operation: z.literal('transition_member'), transitionId: id, membershipId: id }),
  z.object({ operation: z.literal('complete_transition'), transitionId: id }),
  z.object({ operation: z.literal('record_consent'), policyId: id, membershipId: id, signatureName: z.string().trim().min(2).max(200), witnessId: id, place: optionalText }),
  z.object({ operation: z.literal('carry_forward'), loanId: id, asOf: date, note }),
  z.object({ operation: z.literal('record_notice'), meetingId: id, membershipId: id, reasonKind: z.enum(['illness', 'travel', 'work', 'bereavement', 'family', 'not_stated', 'other']), reason: note, via: z.enum(['in_person', 'telephone', 'sms', 'through_another_member', 'written']) }),
  z.object({ operation: z.literal('review_notice'), noticeId: id, decision: z.enum(['approved', 'rejected']), note }),
  z.object({ operation: z.literal('assess_fines'), meetingId: id }),
  payment,
  z.object({ operation: z.literal('cancel_fine'), fineId: id, note }),
  z.object({ operation: z.literal('reverse_fine_payment'), paymentId: id, note }),
  z.object({ operation: z.literal('confirm_death'), claimId: id, membershipId: id, statement: note, relationship: optionalText }),
]);
export type PolicyOperation = z.infer<typeof policyUpdateSchema>;
