import test from 'node:test';
import assert from 'node:assert/strict';

function ratingLabel(value) {
  return {
    0: 'Choisissez une note',
    1: 'À améliorer',
    2: 'Moyen',
    3: 'Bien',
    4: 'Très bien',
    5: 'Excellent',
  }[value] ?? '';
}

function formatPrice(amount) {
  return amount === null || amount === undefined
    ? 'Prix non convenu'
    : `${new Intl.NumberFormat('fr-FR').format(amount)} Ar`;
}

function validateRatingPayload(stars, comment) {
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) {
    throw new Error('INVALID_STARS');
  }
  const cleanComment = typeof comment === 'string' ? comment.trim() : null;
  if (cleanComment && cleanComment.length > 1000) {
    throw new Error('COMMENT_TOO_LONG');
  }
  return {
    stars,
    ...(cleanComment ? { comment: cleanComment } : {}),
  };
}

test('ratingLabel returns the expected French description for each star level', () => {
  assert.equal(ratingLabel(0), 'Choisissez une note');
  assert.equal(ratingLabel(1), 'À améliorer');
  assert.equal(ratingLabel(2), 'Moyen');
  assert.equal(ratingLabel(3), 'Bien');
  assert.equal(ratingLabel(4), 'Très bien');
  assert.equal(ratingLabel(5), 'Excellent');
});

test('formatPrice formats Ariary amounts accurately', () => {
  assert.equal(formatPrice(null), 'Prix non convenu');
  assert.match(formatPrice(5000), /5\s?000\sAr/);
  assert.match(formatPrice(12500), /12\s?500\sAr/);
});

test('validateRatingPayload accepts valid stars and trims optional comment', () => {
  const payload = validateRatingPayload(5, '  Très bonne conduite et ponctuel.  ');
  assert.deepEqual(payload, {
    stars: 5,
    comment: 'Très bonne conduite et ponctuel.',
  });

  const payloadNoComment = validateRatingPayload(4, '');
  assert.deepEqual(payloadNoComment, { stars: 4 });
});

test('validateRatingPayload rejects stars outside 1 to 5', () => {
  assert.throws(() => validateRatingPayload(0), /INVALID_STARS/);
  assert.throws(() => validateRatingPayload(6), /INVALID_STARS/);
  assert.throws(() => validateRatingPayload('5'), /INVALID_STARS/);
});
