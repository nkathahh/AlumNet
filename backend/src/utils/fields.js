/*
 * Text limits that match the database columns. Without them, text longer
 * than a column (or a number or list where text was expected) reaches MySQL,
 * which refuses it, and the member sees a server error instead of being told
 * what to shorten. Lengths are counted the way JavaScript counts them, which
 * is never less than the characters MySQL counts, so a value that passes
 * here always fits.
 */

// Long text goes in TEXT columns (65,535 bytes). 5,000 characters stays well
// inside that even when every character takes 4 bytes.
const LONG_TEXT = 5000;

const LIMITS = {
  opportunity: {
    title: { max: 150, label: 'Role title' },
    company: { max: 150, label: 'Company or department' },
    industry: { max: 100, label: 'Industry' },
    location: { max: 150, label: 'Location' },
    applyLink: { max: 255, label: 'Application link or contact email' },
    description: { max: LONG_TEXT, label: 'Description' },
    requiredSkills: { max: 1000, label: 'Skills' },
    closingDate: { max: 10, label: 'Closing date' },
    opportunityType: { max: 30, label: 'Type' }
  },
  event: {
    title: { max: 150, label: 'Title' },
    location: { max: 255, label: 'Venue or meeting link' },
    description: { max: LONG_TEXT, label: 'Description' },
    topics: { max: 1000, label: 'Topics' },
    eventDate: { max: 40, label: 'Date and time' },
    mode: { max: 20, label: 'Format' }
  }
};

// Largest capacity an event can have (the column is an INT, so a bigger
// number would also be refused by the database)
const MAX_CAPACITY = 10000;

/*
 * Returns an error message for the first field that is the wrong type or
 * too long, or null. Missing fields are left to the required-field checks.
 */
function checkText(body, kind) {
  const limits = LIMITS[kind];
  for (const [key, { max, label }] of Object.entries(limits)) {
    const value = body[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string') return `${label} must be text`;
    if (value.length > max) return `${label} must be ${max.toLocaleString('en-US')} characters or fewer (it is ${value.length.toLocaleString('en-US')})`;
  }
  return null;
}

module.exports = { LIMITS, LONG_TEXT, MAX_CAPACITY, checkText };
