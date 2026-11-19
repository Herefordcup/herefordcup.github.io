function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function sumRecorded(values) {
  const recorded = values.filter(value => value !== null);
  return recorded.length ? recorded.reduce((total, value) => total + value, 0) : null;
}

function equalPoints(left, right) {
  return left !== null && right !== null && Math.abs(left - right) < 0.000001;
}

export function summarizeLegacyLedger(edition = {}) {
  const expectedPoints = finiteNumber(edition.expected_points);
  const blueTotal = finiteNumber(edition.cardinal_total);
  const whiteTotal = finiteNumber(edition.silver_total);
  const results = edition.legacy_results ?? [];

  const availableValues = results.map(result => finiteNumber(result.points_available));
  const blueValues = results.map(result => finiteNumber(result.cardinal_points));
  const whiteValues = results.map(result => finiteNumber(result.silver_points));
  const rowPointsAvailable = sumRecorded(availableValues);
  const rowBlueTotal = sumRecorded(blueValues);
  const rowWhiteTotal = sumRecorded(whiteValues);
  const rowAwardedPoints = sumRecorded([...blueValues, ...whiteValues]);

  const overAllocatedRows = results.filter((result, index) => {
    const available = availableValues[index];
    if (available === null) return false;
    const awarded = (blueValues[index] ?? 0) + (whiteValues[index] ?? 0);
    return awarded > available + 0.000001;
  });

  const unresolvedRows = results.filter((result, index) => {
    const available = availableValues[index];
    if (available === null) return false;
    const blue = blueValues[index];
    const white = whiteValues[index];
    const awarded = (blue ?? 0) + (white ?? 0);
    return result.confidence === 'unresolved'
      || blue === null
      || white === null
      || awarded < available - 0.000001;
  }).length;

  const editionRecordedPoints = blueTotal !== null && whiteTotal !== null
    ? blueTotal + whiteTotal
    : null;
  const recordedPoints = editionRecordedPoints ?? rowAwardedPoints;
  const unresolvedPoints = expectedPoints !== null && recordedPoints !== null
    ? Math.max(expectedPoints - recordedPoints, 0)
    : null;
  const rowTotalsMatchEdition = equalPoints(rowBlueTotal, blueTotal)
    && equalPoints(rowWhiteTotal, whiteTotal);
  const reconciled = edition.score_confidence === 'confirmed'
    && equalPoints(editionRecordedPoints, expectedPoints)
    && overAllocatedRows.length === 0;

  return {
    expectedPoints,
    blueTotal,
    whiteTotal,
    recordedPoints,
    unresolvedPoints,
    unresolvedRows,
    overAllocatedRows,
    reconciled,
    rowPointsAvailable,
    rowBlueTotal,
    rowWhiteTotal,
    rowAwardedPoints,
    rowTotalsMatchEdition,
  };
}
