'use server';

/**
 * The parts of a loan application beyond its core terms: the product's own
 * answers, the guarantors on it, the undertaking each signs, and the
 * documents filed with it.
 *
 * Every function performs the five checks in order — a session exists, the
 * account is active, the capability is held, the input validates, and the
 * target is authorised, the last by running as the caller so Row Level
 * Security and the draft guards decide.
 *
 * ## Nothing here decides whether a question had to be answered
 *
 * The product's `application_profile` decides that, and
 * `validate_loan_for_approval` re-checks it at the moment of the decision. So
 * these actions accept an answer and store it; they do not refuse one the
 * product did not ask for, because a loan officer recording an employer on a
 * business loan has recorded something true.
 *
 * ## The draft rule is the database's
 *
 * Every table written here is frozen from submission by its own trigger. No
 * action below re-states that as a TypeScript check: a second copy of the rule
 * is a second thing to keep in step, and the database's copy is the one an API
 * caller cannot skip. What the actions do is turn the refusal into a sentence
 * a person can act on.
 */

import { revalidatePath } from 'next/cache';

import { ROUTES } from '@/config/app';
import { requirePermission } from '@/lib/auth/context';
import { mapDatabaseError } from '@/lib/db-errors';
import { toPublicError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import {
  removeLoanDocumentObject,
  uploadLoanDocument,
} from '@/lib/storage/loan-documents';
import {
  attachClientGuarantorSchema,
  attachExternalGuarantorSchema,
  businessDetailsSchema,
  isGuarantorDocumentKind,
  recordGuarantorConsentSchema,
  removeLoanDocumentSchema,
  removeLoanGuarantorSchema,
  salaryDetailsSchema,
  uploadLoanDocumentSchema,
} from '@/lib/validation/loan-application';
import { parseSafely } from '@/lib/validation/validate';
import type { ActionResult } from '@/lib/auth/actions';

/**
 * Turn a database error into something a person can act on.
 *
 * `P0001` is passed through: the guards raise messages written for exactly
 * this purpose — "the documents on a pending_approval application cannot be
 * changed" is more useful than anything this layer could invent.
 */
function friendly(error: { code?: string; message?: string }): string {
  if (error.code === 'P0001' && typeof error.message === 'string') {
    return error.message;
  }

  if (error.code === '42501') {
    return 'You do not have permission to do that.';
  }

  if (error.code === '23505') {
    return 'That has already been recorded on this application.';
  }

  return toPublicError(mapDatabaseError(error, 'loan')).message;
}

function revalidateLoan(loanId: string): void {
  revalidatePath(`${ROUTES.loans}/${loanId}`);
  revalidatePath(`${ROUTES.loans}/${loanId}/application`);
  revalidatePath(ROUTES.loans);
}

// ---------------------------------------------------------------------------
// The product's own questions
// ---------------------------------------------------------------------------

/**
 * The employment behind a salary loan.
 *
 * One row per loan, so this is an upsert rather than a create-or-update pair:
 * a staff member correcting a typo is doing the same thing as one entering it
 * for the first time, and two actions would mean the form had to know which.
 */
export async function saveSalaryDetailsAction(
  _previous: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  try {
    await requirePermission('loans:update_draft');
  } catch (error) {
    return { ok: false, message: toPublicError(error).message };
  }

  const parsed = parseSafely(salaryDetailsSchema, {
    loanId: formData.get('loanId'),
    employerName: formData.get('employerName'),
    employerContact: formData.get('employerContact'),
    jobTitle: formData.get('jobTitle'),
    staffNumber: formData.get('staffNumber'),
    netMonthlySalary: formData.get('netMonthlySalary'),
    salaryPayDay: formData.get('salaryPayDay'),
    employmentStartedOn: formData.get('employmentStartedOn'),
    employmentStatus: formData.get('employmentStatus'),
    salaryVerification: formData.get('salaryVerification') ?? 'not_checked',
  });

  if (!parsed.success) {
    return {
      ok: false,
      message: 'Please check the highlighted fields.',
      fieldErrors: parsed.error.fieldErrors,
    };
  }

  const input = parsed.data;
  const supabase = await createSupabaseServerClient();

  const { error } = await supabase.from('loan_salary_details').upsert(
    {
      loan_id: input.loanId,
      employer_name: input.employerName,
      employer_contact: input.employerContact,
      job_title: input.jobTitle,
      staff_number: input.staffNumber,
      net_monthly_salary: input.netMonthlySalary,
      salary_pay_day: input.salaryPayDay,
      employment_started_on: input.employmentStartedOn,
      employment_status: input.employmentStatus,
      salary_verification: input.salaryVerification,
    },
    { onConflict: 'loan_id' },
  );

  if (error !== null) {
    logger.warn('Could not save the salary details on an application.', {
      code: error.code,
    });
    return { ok: false, message: friendly(error) };
  }

  revalidateLoan(input.loanId);

  return { ok: true, message: 'The employment details have been saved.' };
}

/** The trading business behind a business loan. Upserted, for the same reason. */
export async function saveBusinessDetailsAction(
  _previous: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  try {
    await requirePermission('loans:update_draft');
  } catch (error) {
    return { ok: false, message: toPublicError(error).message };
  }

  const parsed = parseSafely(businessDetailsSchema, {
    loanId: formData.get('loanId'),
    businessName: formData.get('businessName'),
    businessType: formData.get('businessType'),
    businessLocation: formData.get('businessLocation'),
    businessContact: formData.get('businessContact'),
    tradingSince: formData.get('tradingSince'),
    monthlyTurnover: formData.get('monthlyTurnover'),
    monthlyExpenses: formData.get('monthlyExpenses'),
    employeeCount: formData.get('employeeCount'),
    premisesOwnership: formData.get('premisesOwnership'),
    tradingLicenceNumber: formData.get('tradingLicenceNumber'),
    loanPurpose: formData.get('loanPurpose'),
  });

  if (!parsed.success) {
    return {
      ok: false,
      message: 'Please check the highlighted fields.',
      fieldErrors: parsed.error.fieldErrors,
    };
  }

  const input = parsed.data;
  const supabase = await createSupabaseServerClient();

  const { error } = await supabase.from('loan_business_details').upsert(
    {
      loan_id: input.loanId,
      business_name: input.businessName,
      business_type: input.businessType,
      business_location: input.businessLocation,
      business_contact: input.businessContact,
      trading_since: input.tradingSince,
      monthly_turnover: input.monthlyTurnover,
      monthly_expenses: input.monthlyExpenses,
      employee_count: input.employeeCount,
      premises_ownership: input.premisesOwnership,
      trading_licence_number: input.tradingLicenceNumber,
      loan_purpose: input.loanPurpose,
    },
    { onConflict: 'loan_id' },
  );

  if (error !== null) {
    logger.warn('Could not save the business details on an application.', {
      code: error.code,
    });
    return { ok: false, message: friendly(error) };
  }

  revalidateLoan(input.loanId);

  return { ok: true, message: 'The business details have been saved.' };
}

// ---------------------------------------------------------------------------
// Guarantors
// ---------------------------------------------------------------------------

/**
 * Attach somebody already in the client register.
 *
 * The client is *referenced*, never copied. A second identity record for the
 * same person is how a register comes to hold two of somebody with different
 * phone numbers, and the eligibility trigger behind this would still have had
 * to decide which one it meant.
 */
export async function attachClientGuarantorAction(
  _previous: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  try {
    await requirePermission('guarantors:link');
  } catch (error) {
    return { ok: false, message: toPublicError(error).message };
  }

  const parsed = parseSafely(attachClientGuarantorSchema, {
    loanId: formData.get('loanId'),
    guarantorClientId: formData.get('guarantorClientId'),
    relationshipToClient: formData.get('relationshipToClient'),
  });

  if (!parsed.success) {
    return {
      ok: false,
      message: 'Choose a client and say how they are related to the borrower.',
      fieldErrors: parsed.error.fieldErrors,
    };
  }

  const input = parsed.data;
  const supabase = await createSupabaseServerClient();

  const { error } = await supabase.from('loan_guarantors').insert({
    loan_id: input.loanId,
    guarantor_client_id: input.guarantorClientId,
    relationship_to_client: input.relationshipToClient,
  });

  if (error !== null) {
    logger.warn('Could not attach a client guarantor.', { code: error.code });
    return { ok: false, message: friendly(error) };
  }

  revalidateLoan(input.loanId);

  return {
    ok: true,
    message: 'The guarantor has been added. They still have to sign the undertaking.',
  };
}

/**
 * Capture somebody new, from inside the application.
 *
 * Three writes in sequence — the guarantor, their identification, the link to
 * this loan — and the order matters: the guarantor record has to exist before
 * anything can reference it. If the second or third fails the first is left
 * behind, which is a guarantor in the register with no loan attached. That is
 * recoverable by a staff member and visible in the directory; the alternative
 * is a Postgres function taking eleven arguments, which is a larger surface to
 * get wrong for a failure mode that leaves a usable record either way.
 *
 * The guarantor appears in the Guarantors Register from the moment the first
 * write commits, which is the point: staff should not have to pre-register
 * somebody before they can be captured on an application.
 */
export async function attachExternalGuarantorAction(
  _previous: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  try {
    // Two writes, two capabilities: registering the person, and attaching
    // them to this application. Checking both here turns a policy refusal
    // half-way through into a sentence before anything is written.
    await requirePermission('guarantors:create');
    await requirePermission('guarantors:link');
  } catch (error) {
    return { ok: false, message: toPublicError(error).message };
  }

  const parsed = parseSafely(attachExternalGuarantorSchema, {
    loanId: formData.get('loanId'),
    fullName: formData.get('fullName'),
    sex: formData.get('sex'),
    dateOfBirth: formData.get('dateOfBirth'),
    phone: formData.get('phone'),
    alternativePhone: formData.get('alternativePhone'),
    occupation: formData.get('occupation'),
    employerName: formData.get('employerName'),
    location: formData.get('location'),
    district: formData.get('district'),
    nin: formData.get('nin'),
    relationshipToClient: formData.get('relationshipToClient'),
  });

  if (!parsed.success) {
    return {
      ok: false,
      message: 'Please check the highlighted fields.',
      fieldErrors: parsed.error.fieldErrors,
    };
  }

  const input = parsed.data;
  const supabase = await createSupabaseServerClient();

  const { data: created, error: createError } = await supabase
    .from('guarantors')
    .insert({
      full_name: input.fullName,
      sex: input.sex,
      date_of_birth: input.dateOfBirth,
      phone: input.phone,
      alternative_phone: input.alternativePhone,
      occupation: input.occupation,
      employer_name: input.employerName,
      location: input.location,
      district: input.district,
    })
    .select('id')
    .single();

  if (createError !== null) {
    logger.warn('Could not register a guarantor from an application.', {
      code: createError.code,
    });
    return { ok: false, message: friendly(createError) };
  }

  if (input.nin !== null) {
    const { error: ninError } = await supabase
      .from('guarantor_identities')
      .insert({ guarantor_id: created.id, nin: input.nin });

    if (ninError !== null) {
      logger.warn('A guarantor was registered without their identification.', {
        code: ninError.code,
      });
      return {
        ok: false,
        message: `${input.fullName} has been added to the register, but their identification could not be saved: ${friendly(ninError)}`,
      };
    }
  }

  const { error: linkError } = await supabase.from('loan_guarantors').insert({
    loan_id: input.loanId,
    guarantor_id: created.id,
    relationship_to_client: input.relationshipToClient,
  });

  if (linkError !== null) {
    logger.warn('Could not attach a newly registered guarantor.', {
      code: linkError.code,
    });
    return {
      ok: false,
      message: `${input.fullName} has been added to the register, but could not be attached to this application: ${friendly(linkError)}`,
    };
  }

  revalidateLoan(input.loanId);
  revalidatePath(ROUTES.guarantors);

  return {
    ok: true,
    message: `${input.fullName} has been added to this application and to the guarantor register. They still have to sign the undertaking.`,
  };
}

/** Take a guarantor off an application. Refused once it has left draft. */
export async function removeLoanGuarantorAction(
  _previous: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  try {
    await requirePermission('guarantors:link');
  } catch (error) {
    return { ok: false, message: toPublicError(error).message };
  }

  const parsed = parseSafely(removeLoanGuarantorSchema, {
    loanId: formData.get('loanId'),
    loanGuarantorId: formData.get('loanGuarantorId'),
  });

  if (!parsed.success)
    return { ok: false, message: 'That guarantor was not recognised.' };

  const input = parsed.data;
  const supabase = await createSupabaseServerClient();

  const { error } = await supabase
    .from('loan_guarantors')
    .delete()
    .eq('id', input.loanGuarantorId)
    .eq('loan_id', input.loanId);

  if (error !== null) {
    logger.warn('Could not remove a guarantor from an application.', {
      code: error.code,
    });
    return { ok: false, message: friendly(error) };
  }

  revalidateLoan(input.loanId);

  return { ok: true, message: 'The guarantor has been removed from this application.' };
}

/**
 * Record the undertaking a guarantor signed.
 *
 * The version is read server-side from the terms in force, never accepted from
 * the form: a guarantor cannot be held to words they were not shown, and a
 * browser that could name the version could name an older one. The timestamp
 * is the database's `now()` for the same reason.
 *
 * Write-once. `loan_guarantors_guard_snapshot` refuses a change to a signed
 * consent, so a correction is a fresh consent taken after the guarantor is
 * removed and re-added — which is what actually happens on paper.
 */
export async function recordGuarantorConsentAction(
  _previous: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  try {
    await requirePermission('guarantors:link');
  } catch (error) {
    return { ok: false, message: toPublicError(error).message };
  }

  const parsed = parseSafely(recordGuarantorConsentSchema, {
    loanId: formData.get('loanId'),
    loanGuarantorId: formData.get('loanGuarantorId'),
    signatureName: formData.get('signatureName'),
    witnessName: formData.get('witnessName'),
    witnessPhone: formData.get('witnessPhone'),
    consentPlace: formData.get('consentPlace'),
    accepted: formData.get('accepted') ?? undefined,
  });

  if (!parsed.success) {
    return {
      ok: false,
      message: 'Please check the highlighted fields.',
      fieldErrors: parsed.error.fieldErrors,
    };
  }

  const input = parsed.data;
  const supabase = await createSupabaseServerClient();

  const { data: terms, error: termsError } = await supabase
    .from('guarantor_consent_terms')
    .select('id, version')
    .eq('is_current', true)
    .maybeSingle();

  if (termsError !== null || terms === null) {
    logger.error('No guarantor undertaking is in force.', { code: termsError?.code });
    return {
      ok: false,
      message:
        'No guarantor undertaking is currently published, so a consent cannot be recorded. Contact your administrator.',
    };
  }

  const { error } = await supabase
    .from('loan_guarantors')
    .update({
      consent_terms_id: terms.id,
      consent_version: terms.version,
      consented_at: new Date().toISOString(),
      signature_name: input.signatureName,
      witness_name: input.witnessName,
      witness_phone: input.witnessPhone,
      consent_place: input.consentPlace,
    })
    .eq('id', input.loanGuarantorId)
    .eq('loan_id', input.loanId);

  if (error !== null) {
    logger.warn('Could not record a guarantor consent.', { code: error.code });
    return { ok: false, message: friendly(error) };
  }

  revalidateLoan(input.loanId);

  return {
    ok: true,
    message: `The undertaking has been recorded against version ${terms.version}.`,
  };
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

/**
 * File a document against an application.
 *
 * The object is uploaded first and the row written second. If the row fails
 * the object is removed, so the bucket does not accumulate files nothing
 * references — and if that removal fails too, the leftover is an orphan with
 * a random name in a private bucket, which is clutter rather than a leak.
 */
export async function uploadLoanDocumentAction(
  _previous: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  try {
    await requirePermission('loans:documents');
  } catch (error) {
    return { ok: false, message: toPublicError(error).message };
  }

  const parsed = parseSafely(uploadLoanDocumentSchema, {
    loanId: formData.get('loanId'),
    kind: formData.get('kind'),
    loanGuarantorId: formData.get('loanGuarantorId'),
    label: formData.get('label'),
  });

  if (!parsed.success) {
    return {
      ok: false,
      message: 'Please check the highlighted fields.',
      fieldErrors: parsed.error.fieldErrors,
    };
  }

  const input = parsed.data;
  const file = formData.get('file');

  if (!(file instanceof File)) {
    return { ok: false, message: 'Choose a file to upload.' };
  }

  // The three guarantor kinds belong to a guarantor; everything else belongs
  // to the application. The constraint says the same thing, but saying it here
  // turns a constraint violation into a sentence.
  if (isGuarantorDocumentKind(input.kind) && input.loanGuarantorId === null) {
    return { ok: false, message: 'Choose which guarantor this document belongs to.' };
  }

  if (!isGuarantorDocumentKind(input.kind) && input.loanGuarantorId !== null) {
    return { ok: false, message: 'That kind of document belongs to the application.' };
  }

  const upload = await uploadLoanDocument(input.loanId, input.kind, file);

  if (!upload.ok || upload.path === undefined) {
    return { ok: false, message: upload.message ?? 'That file could not be saved.' };
  }

  const supabase = await createSupabaseServerClient();

  const { error } = await supabase.from('loan_documents').insert({
    loan_id: input.loanId,
    loan_guarantor_id: input.loanGuarantorId,
    kind: input.kind,
    storage_path: upload.path,
    label: input.label,
    content_type: upload.contentType ?? file.type,
    byte_size: upload.byteSize ?? file.size,
  });

  if (error !== null) {
    await removeLoanDocumentObject(upload.path);
    logger.warn('Could not record a loan document.', { code: error.code });
    return { ok: false, message: friendly(error) };
  }

  revalidateLoan(input.loanId);

  return { ok: true, message: 'The document has been filed with this application.' };
}

/**
 * Remove a filed document.
 *
 * The row goes first and the object second, which is the order that fails
 * safely: a row with no object is a document the screen offers and storage
 * cannot produce; an object with no row is invisible.
 */
export async function removeLoanDocumentAction(
  _previous: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  try {
    await requirePermission('loans:documents');
  } catch (error) {
    return { ok: false, message: toPublicError(error).message };
  }

  const parsed = parseSafely(removeLoanDocumentSchema, {
    loanId: formData.get('loanId'),
    documentId: formData.get('documentId'),
  });

  if (!parsed.success) return { ok: false, message: 'That document was not recognised.' };

  const input = parsed.data;
  const supabase = await createSupabaseServerClient();

  const { data: removed, error } = await supabase
    .from('loan_documents')
    .delete()
    .eq('id', input.documentId)
    .eq('loan_id', input.loanId)
    .select('storage_path')
    .maybeSingle();

  if (error !== null) {
    logger.warn('Could not remove a loan document.', { code: error.code });
    return { ok: false, message: friendly(error) };
  }

  if (removed !== null) {
    await removeLoanDocumentObject(removed.storage_path);
  }

  revalidateLoan(input.loanId);

  return { ok: true, message: 'The document has been removed.' };
}
