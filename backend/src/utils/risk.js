/*
 * Compares what a person entered at sign-up with the HR record, so the
 * admin sees the evidence already weighed instead of investigating from
 * scratch. The admin always makes the final decision.
 */

function nameTokens(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z\s'-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

// Order-insensitive: "Otieno Brian" matches "Brian Otieno"
function namesMatch(entered, onRecord) {
  const a = new Set(nameTokens(entered));
  const b = new Set(nameTokens(onRecord));
  if (!a.size || !b.size) return false;
  const shared = [...a].filter((t) => b.has(t)).length;
  return shared >= Math.min(2, b.size) && shared / Math.max(a.size, b.size) >= 0.5;
}

// Kenyan numbers in any common format: 0712..., +254712..., 254712...
function phoneDigits(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length >= 9 ? digits.slice(-9) : null;
}

function phonesMatch(entered, onRecord) {
  const a = phoneDigits(entered);
  const b = phoneDigits(onRecord);
  return Boolean(a && b && a === b);
}

function maskEmail(email) {
  if (!email) return null;
  const [user, domain] = String(email).split('@');
  if (!domain) return '***';
  return `${user.slice(0, 1)}${'•'.repeat(Math.max(2, Math.min(user.length - 1, 6)))}@${domain}`;
}

/*
 * staff: HR record or null
 * context: { alreadyRegistered, recentAttempts, emailInUse }
 */
function assessSignup({ fullName, phone, email }, staff, context) {
  const signals = [];
  const add = (ok, label) => signals.push({ ok, label });

  add(Boolean(staff), staff ? 'Staff number found in HR records' : 'Staff number not found in HR records');
  if (staff) {
    add(Boolean(staff.alumni_eligible), staff.alumni_eligible ? 'Eligible for the alumni network' : 'HR marks this person as not eligible');
    add(namesMatch(fullName, staff.full_name), namesMatch(fullName, staff.full_name) ? 'Name matches HR record' : `Name does not match HR record (${staff.full_name})`);
    add(phonesMatch(phone, staff.mobile_number), phonesMatch(phone, staff.mobile_number) ? 'Phone matches HR record' : 'Phone does not match HR record');
    const hrEmail = staff.employment_status === 'active' ? staff.kq_email : staff.personal_email;
    add(false, hrEmail ? `Email differs from HR record (HR holds ${maskEmail(hrEmail)})` : 'HR holds no email for this person');
  }
  add(!context.alreadyRegistered, context.alreadyRegistered ? 'This staff number already has an account' : 'No existing account for this staff number');
  add(context.recentAttempts < 3, `${context.recentAttempts} sign-up attempt${context.recentAttempts === 1 ? '' : 's'} for this staff number in 30 days`);
  if (context.emailInUse) add(false, 'This email is already used by another account');

  const nameOk = staff && namesMatch(fullName, staff.full_name);
  const phoneOk = staff && phonesMatch(phone, staff.mobile_number);

  let level;
  let suggestion;
  if (!staff || !staff.alumni_eligible || context.alreadyRegistered || context.recentAttempts >= 3 || context.emailInUse || (!nameOk && !phoneOk)) {
    level = 'high';
    suggestion = 'High risk. Reject unless you can confirm the person through HR.';
  } else if (nameOk && phoneOk) {
    level = 'low';
    suggestion = 'Likely genuine: details match HR except the email, which has probably changed.';
  } else {
    level = 'medium';
    suggestion = 'Partly matches. Phone the number HR holds before approving.';
  }
  return { level, suggestion, signals };
}

module.exports = { namesMatch, phonesMatch, maskEmail, assessSignup };
