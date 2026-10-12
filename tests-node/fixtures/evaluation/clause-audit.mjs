// Scripted structural fixtures only; never live semantic evidence.
export const clauseAuditFixture=(input,equivalent=true,semanticEquivalent=equivalent)=>({verdicts:input.predictions.map((p,predictionIndex)=>({predictionIndex,supportClausesEquivalent:equivalent,semanticClausesEquivalent:semanticEquivalent}))});
