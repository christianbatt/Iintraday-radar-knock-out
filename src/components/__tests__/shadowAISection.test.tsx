import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ShadowAISection from '../ShadowAISection';

describe('ShadowAISection — flag', () => {
  it('flag off: non renderizza nulla', () => {
    const out = renderToStaticMarkup(React.createElement(ShadowAISection, { flag: 'off' }));
    assert.equal(out, '');
  });

  it('flag on: renderizza sezione', () => {
    const out = renderToStaticMarkup(React.createElement(ShadowAISection, { flag: 'on', entries: [] }));
    assert.ok(out.includes('data-testid="shadow-ai-section"'));
    assert.ok(out.includes('NON VALIDATO') === false || out.includes('shadow-ai-empty'));
  });
});
