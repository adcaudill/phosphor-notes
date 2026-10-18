import { describe, it, expect } from 'vitest';
import { redactText, redactValue, SSN_MASK, CARD_MASK } from '../mcp/redact';
import { toCallToolResult, toErrorResult } from '../mcp/toolkit';

describe('MCP PII redaction', () => {
  it('masks SSNs with hyphen or space separators', () => {
    expect(redactText('SSN: 123-45-6789.')).toBe(`SSN: ${SSN_MASK}.`);
    expect(redactText('ssn 123 45 6789 end')).toBe(`ssn ${SSN_MASK} end`);
  });

  it('leaves non-SSN number shapes alone', () => {
    expect(redactText('call 555-123-4567')).toBe('call 555-123-4567');
    expect(redactText('date 2026-10-18')).toBe('date 2026-10-18');
    expect(redactText('mixed 123-45 6789')).toBe('mixed 123-45 6789');
    expect(redactText('longer 1123-45-67890')).toBe('longer 1123-45-67890');
  });

  it('masks Luhn-valid 16-digit card numbers in common formats', () => {
    expect(redactText('visa 4111111111111111')).toBe(`visa ${CARD_MASK}`);
    expect(redactText('visa 4111 1111 1111 1111')).toBe(`visa ${CARD_MASK}`);
    expect(redactText('mc 5500-0000-0000-0004 ok')).toBe(`mc ${CARD_MASK} ok`);
  });

  it('masks Luhn-valid 15-digit Amex numbers', () => {
    expect(redactText('amex 378282246310005')).toBe(`amex ${CARD_MASK}`);
    expect(redactText('amex 3782 822463 10005')).toBe(`amex ${CARD_MASK}`);
    expect(redactText('amex 3782-822463-10005')).toBe(`amex ${CARD_MASK}`);
  });

  it('finds a card number preceded by an unrelated digit group', () => {
    expect(redactText('ref 1234 4111 1111 1111 1111')).toBe(`ref 1234 ${CARD_MASK}`);
    expect(redactText('123-45-6789 4111 1111 1111 1111')).toBe(`${SSN_MASK} ${CARD_MASK}`);
  });

  it('leaves digit runs that fail Luhn or have the wrong length alone', () => {
    expect(redactText('id 4111111111111112')).toBe('id 4111111111111112');
    expect(redactText('ts 41111111111111110')).toBe('ts 41111111111111110');
    expect(redactText('short 41111111111111')).toBe('short 41111111111111');
  });

  it('masks every string in a nested value, including keys', () => {
    const input = {
      path: 'notes/123-45-6789.md',
      count: 3,
      flag: true,
      empty: null,
      items: [{ text: 'card 4111111111111111' }, 'plain'],
      byName: { '123-45-6789': 1 }
    };
    expect(redactValue(input)).toEqual({
      path: `notes/${SSN_MASK}.md`,
      count: 3,
      flag: true,
      empty: null,
      items: [{ text: `card ${CARD_MASK}` }, 'plain'],
      byName: { [SSN_MASK]: 1 }
    });
    expect(input.path).toBe('notes/123-45-6789.md');
  });

  it('applies to both the text and structured tool output, and to error messages', () => {
    const result = toCallToolResult({ content: 'SSN 123-45-6789' });
    expect(result.structuredContent).toEqual({ content: `SSN ${SSN_MASK}` });
    const text = (result.content[0] as { text: string }).text;
    expect(text).not.toContain('123-45-6789');
    expect(text).toContain(SSN_MASK);

    const error = toErrorResult('LINE_MISMATCH', 'expected "4111 1111 1111 1111"');
    expect((error.content[0] as { text: string }).text).toBe(
      `LINE_MISMATCH: expected "${CARD_MASK}"`
    );
  });
});
