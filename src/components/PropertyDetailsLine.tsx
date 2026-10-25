// Clear to Close — property details line (Oct 25, 2026 packet).
//
// The ONE compact line under the address, shared by the realtor escrow
// page and the client views: "4 bd · 2.5 ba · 2,140 sq ft · Lot
// 7,500 sq ft · Single-family · Built 1998 · Listed $875,000". Only
// the fields actually entered render; when none are set the component
// renders nothing at all. Segment building lives in
// src/lib/propertyDetails.ts (propertyLineSegments) so the text is
// unit-tested; this component is presentation only.
//
// Variants: 'ruled' — the line itself with a top rule (realtor escrow
// page header, under the address block); 'card' — the same line in a
// slim white card (client views, directly below the top card).
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { propertyLineSegments } from '../lib/propertyDetails';
import type { PropertyDetails } from '../lib/types';
import { colors } from '../theme';

export function PropertyDetailsLine({
  details,
  variant = 'ruled',
}: {
  details?: PropertyDetails | null;
  variant?: 'ruled' | 'card';
}) {
  if (!details) return null;
  const segs = propertyLineSegments(details);
  if (!segs) return null;
  const line = (
    <Text style={styles.line} testID="property-details-line">
      {segs.map((s, i) => (
        <Text key={i}>
          {i > 0 ? ' · ' : ''}
          {s.runs.map((r, j) => (
            <Text key={j} style={r.strong ? styles.strong : undefined}>
              {r.text}
            </Text>
          ))}
        </Text>
      ))}
    </Text>
  );
  if (variant === 'card') return <View style={styles.card}>{line}</View>;
  return <View style={styles.ruled}>{line}</View>;
}

const styles = StyleSheet.create({
  line: {
    fontSize: 13,
    color: colors.body,
    lineHeight: 20.8,
  },
  strong: {
    color: colors.ink,
    fontWeight: '600',
  },
  ruled: {
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: colors.line,
  },
  card: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 14,
    paddingVertical: 10,
    paddingHorizontal: 14,
    marginBottom: 12,
  },
});
