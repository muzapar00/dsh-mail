/**
 * HTML sanitizer tests — zero-tolerance XSS payload set (SPEC §0 T2).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  sanitizeHtml,
  sanitizeHtmlDetailed,
  sanitizeUrl,
  escapeAttribute,
  escapeText,
  BLOCKED_IMAGE_CLASS,
} from '../../lib/mail/html.js';

/** Assert that sanitized output contains none of the dangerous patterns. */
function assertClean(html, { allowRemoteImages = false } = {}) {
  const output = sanitizeHtml(html, { allowRemoteImages });
  const lower = output.toLowerCase();
  // 1) No executable elements may survive as real tags. Escaped text such as
  //    `&lt;img ...>` is inert and is allowed.
  const forbiddenTags = [
    '<script', '</script', '<iframe', '</iframe', '<object', '<embed', '<form',
    '<input', '<button', '<select', '<textarea', '<style', '<link', '<base',
    '<meta', '<svg', '<math', '<!--', '<!doctype', '<plaintext', '<xmp',
  ];
  for (const pattern of forbiddenTags) {
    if (lower.includes(pattern)) {
      assert.fail(`sanitized output still contains ${pattern}: ${output.slice(0, 300)}`);
    }
  }
  // 2) No dangerous attributes may survive inside any real tag.
  const tags = output.match(/<\/?[a-z][^>]*>/gi) ?? [];
  const unsafeAttribute = /\bon[a-z]+\s*=|javascript:|vbscript:|expression\s*\(|@import|behavior\s*:|position\s*:|url\s*\//;
  for (const tag of tags) {
    if (unsafeAttribute.test(tag.toLowerCase())) {
      assert.fail(`unsafe attribute survived in ${tag}: ${output.slice(0, 300)}`);
    }
    if (/\ssrc\s*=\s*["']?\s*data:text\/html/i.test(tag)) {
      assert.fail(`data:text/html src survived in ${tag}`);
    }
  }
  return output;
}

/** Classic and modern XSS payloads. Each string is raw untrusted mail HTML. */
const XSS_PAYLOADS = [
  '<script>alert(1)</script>',
  '<SCRIPT SRC="https://evil.example/x.js"></SCRIPT>',
  '<scr<script>ipt>alert(1)</scr</script>ipt>',
  '<img src=x onerror=alert(1)>',
  '<img src="x" onerror = "alert(1)" />',
  '<img src=x onerror=alert(1)//>',
  '<img/src=x/onerror=alert(1)>',
  '<a href="javascript:alert(1)">click</a>',
  '<a href="JaVaScRiPt:alert(1)">click</a>',
  '<a href=" javascript:alert(1)">click</a>',
  '<a href="jav&#x61;script:alert(1)">click</a>',
  '<a href="&#106;&#97;&#118;&#97;&#115;&#99;&#114;&#105;&#112;&#116;&#58;alert(1)">click</a>',
  '<a href="javascript&colon;alert(1)">click</a>',
  '<a href="java\tscript:alert(1)">click</a>',
  '<a href="java\nscript:alert(1)">click</a>',
  '<a href="vbscript:msgbox(1)">click</a>',
  '<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">click</a>',
  '<a href="//evil.example/x">protocol-relative</a>',
  '<iframe src="https://evil.example"></iframe>',
  '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
  '<object data="javascript:alert(1)"></object>',
  '<embed src="https://evil.example/x.swf">',
  '<form action="https://evil.example"><input name="q"><button>go</button></form>',
  '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">',
  '<link rel="stylesheet" href="https://evil.example/x.css">',
  '<base href="https://evil.example/">',
  '<svg onload=alert(1)><circle r="5"/></svg>',
  '<svg><script>alert(1)</script></svg>',
  '<math><mtext><script>alert(1)</script></mtext></math>',
  '<div style="background-image:url(javascript:alert(1))">x</div>',
  '<div style="background:url(https://evil.example/x.png)">x</div>',
  '<div style="width:expression(alert(1))">x</div>',
  '<div style="position:fixed;top:0;left:0;width:100vw;height:100vh">overlay</div>',
  '<div style="z-index:9999;behavior:url(x.htc)">x</div>',
  '<p onclick="alert(1)" onmouseover="alert(2)">x</p>',
  '<img src="cid:x" onerror="alert(1)">',
  '<style>body{background:url(javascript:alert(1))}</style>',
  '<noscript><img src=x onerror=alert(1)></noscript>',
  '<template><img src=x onerror=alert(1)></template>',
  '<!--<script>alert(1)</script>--><p>safe</p>',
  '<![CDATA[<script>alert(1)</script>]]>',
  '<plaintext><img src=x onerror=alert(1)>',
  '<xmp><script>alert(1)</script></xmp>',
  '<img src="x" srcset="https://evil.example/a.png 1x">',
  '<img src="x" onerror="&#97;lert(1)">',
  '<image src=x onerror=alert(1)>',
  '<details open ontoggle=alert(1)>x</details>',
  '<body onload=alert(1)>body</body>',
  '<html><head><script>alert(1)</script></head><body>ok</body></html>',
];

describe('sanitizeHtml: XSS payload set', () => {
  for (const [index, payload] of XSS_PAYLOADS.entries()) {
    it(`neutralizes payload #${index + 1}: ${payload.slice(0, 60)}`, () => {
      const output = assertClean(payload);
      // Also verify the result is still a string and does not contain markup that
      // the client would render as a script-capable element.
      assert.equal(typeof output, 'string');
    });
  }

  it('removes script content entirely instead of keeping the code as text', () => {
    const output = sanitizeHtml('<div>before<script>alert("xss")</script>after</div>');
    assert.equal(output, '<div>beforeafter</div>');
  });

  it('keeps harmless markup while stripping dangerous attributes', () => {
    const output = sanitizeHtml('<div class="x" id="y" data-z="1" onclick="evil()"><b>hello</b> <i>world</i></div>');
    assert.equal(output, '<div><b>hello</b> <i>world</i></div>');
    assert.doesNotMatch(output, /class=|id=|data-z|onclick/);
  });
});

describe('sanitizeHtml: links', () => {
  it('keeps http/https/mailto links with rel=noopener noreferrer and target=_blank', () => {
    const output = sanitizeHtml('<a href="https://example.com/x?y=1&amp;z=2" target="_self" rel="opener">L</a>'
      + '<a href="mailto:someone@example.com">M</a>');
    assert.match(output, /<a href="https:\/\/example\.com\/x\?y=1&amp;z=2" target="_blank" rel="noopener noreferrer">L<\/a>/);
    assert.match(output, /<a href="mailto:someone@example\.com" target="_blank" rel="noopener noreferrer">M<\/a>/);
  });

  it('drops unsafe href but keeps the link text', () => {
    assert.equal(sanitizeHtml('<a href="javascript:alert(1)">text</a>'), '<a target="_blank" rel="noopener noreferrer">text</a>');
    assert.equal(sanitizeHtml('<a href="data:text/html,x">text</a>'), '<a target="_blank" rel="noopener noreferrer">text</a>');
  });

  it('sanitizeUrl handles obfuscation and safe schemes', () => {
    assert.equal(sanitizeUrl('https://example.com/a'), 'https://example.com/a');
    assert.equal(sanitizeUrl('  HTTP://example.com  '), 'HTTP://example.com');
    assert.equal(sanitizeUrl('mailto:a@b.example'), 'mailto:a@b.example');
    assert.equal(sanitizeUrl('javascript:alert(1)'), null);
    assert.equal(sanitizeUrl('jav&#x61;script:alert(1)'), null);
    assert.equal(sanitizeUrl('java\tscript:alert(1)'), null);
    assert.equal(sanitizeUrl('data:text/html;base64,PHNjcmlwdD4='), null);
    assert.equal(sanitizeUrl('cid:logo@x', { allowCid: true }), 'cid:logo@x');
    assert.equal(sanitizeUrl('cid:logo@x'), null);
    assert.equal(sanitizeUrl('/relative'), null);
    assert.equal(sanitizeUrl('//evil.example'), null);
  });
});

describe('sanitizeHtml: images', () => {
  const remote = '<img src="https://cdn.example/x.png" alt="pic" width="100" height="50" onerror="alert(1)">';

  it('blocks remote images by default and keeps a placeholder hint', () => {
    const output = sanitizeHtml(remote);
    assert.doesNotMatch(output, /\ssrc="https:/);
    assert.match(output, /data-blocked-src="https:\/\/cdn\.example\/x\.png"/);
    assert.match(output, new RegExp(`class="${BLOCKED_IMAGE_CLASS}"`));
    assert.match(output, /alt="pic"/);
    assert.match(output, /width="100"/);
    assert.doesNotMatch(output, /onerror/);
  });

  it('keeps remote images when allowRemoteImages is enabled (with privacy attrs)', () => {
    const output = sanitizeHtml(remote, { allowRemoteImages: true });
    assert.match(output, /src="https:\/\/cdn\.example\/x\.png"/);
    assert.match(output, /loading="lazy"/);
    assert.match(output, /referrerpolicy="no-referrer"/);
    assert.doesNotMatch(output, /onerror/);
  });

  it('keeps cid: images and resolves them through the trusted resolver', () => {
    assert.equal(sanitizeHtml('<img src="cid:logo@x">'), '<img src="cid:logo@x">');
    const resolved = sanitizeHtml('<img src="cid:logo@x">', {
      resolveCid: (cid) => (cid === 'logo@x' ? 'data:image/png;base64,iVBORw0KGgo=' : null),
    });
    assert.match(resolved, /src="data:image\/png;base64,iVBORw0KGgo="/);
    const refused = sanitizeHtml('<img src="cid:logo@x">', { resolveCid: () => 'javascript:alert(1)' });
    assert.doesNotMatch(refused, /javascript:/);
    assert.match(refused, /data-blocked-src="cid:logo@x"/);
    const remoteMapped = sanitizeHtml('<img src="cid:logo@x">', { resolveCid: () => 'https://cdn.example/x.png' });
    assert.doesNotMatch(remoteMapped, /src="https:/);
  });

  it('rejects data: image URLs unless explicitly allowed', () => {
    const dataImage = '<img src="data:image/png;base64,iVBORw0KGgo=">';
    assert.doesNotMatch(sanitizeHtml(dataImage), /src="data:/);
    assert.match(sanitizeHtml(dataImage, { allowDataImages: true }), /src="data:image\/png;base64,/);
    assert.doesNotMatch(sanitizeHtml('<img src="data:image/svg+xml;base64,PHN2Zz4=">', { allowDataImages: true }), /src="data:/);
  });
});

describe('sanitizeHtml: styles', () => {
  it('keeps safe typography and drops dangerous properties', () => {
    const output = sanitizeHtml('<p style="color:#333;font-size:14px;background-color:#fff;position:absolute;top:0;margin:0 auto">x</p>');
    assert.match(output, /color:#333/);
    assert.match(output, /font-size:14px/);
    assert.match(output, /margin:0 auto/);
    assert.doesNotMatch(output, /position/);
    assert.doesNotMatch(output, /top:/);
  });

  it('drops url(), expression(), CSS escapes and @import', () => {
    for (const style of [
      'background-color:url(https://evil.example/x.png)',
      'color:expression(alert(1))',
      'font-family:\\65 xpression(alert(1))',
      'color:red;behavior:url(x.htc)',
      'color:red /* comment */',
    ]) {
      const output = sanitizeHtml(`<div style="${style}">x</div>`);
      assert.doesNotMatch(output, /url\(|expression|behavior|\\|\/\*/);
    }
  });

  it('drops the whole style attribute when nothing safe remains', () => {
    assert.equal(sanitizeHtml('<div style="position:fixed;z-index:9">x</div>'), '<div>x</div>');
  });
});

describe('sanitizeHtml: structure and limits', () => {
  it('removes comments, doctype and processing instructions', () => {
    assert.equal(sanitizeHtml('<!doctype html><!-- hi --><p>a</p><?php echo 1; ?>'), '<p>a</p>');
  });

  it('keeps formatting tags and tables', () => {
    const html = '<table width="600" cellpadding="0"><tr><td colspan="2" bgcolor="#eee"><b>hi</b></td></tr></table>';
    const output = sanitizeHtml(html);
    assert.match(output, /<table width="600" cellpadding="0">/);
    assert.match(output, /<td colspan="2" bgcolor="#eee">/);
    assert.match(output, /<b>hi<\/b>/);
  });

  it('balances unclosed and mis-nested tags', () => {
    assert.equal(sanitizeHtml('<b>bold <i>italic</b> tail'), '<b>bold <i>italic</i></b> tail');
    assert.equal(sanitizeHtml('<p>one<p>two'), '<p>one</p><p>two</p>');
  });

  it('escapes stray "<" that is not a tag', () => {
    assert.equal(sanitizeHtml('1 < 2 and 3 > 2'), '1 &lt; 2 and 3 > 2');
  });

  it('never swallows the rest of the document for void dropped tags', () => {
    assert.equal(sanitizeHtml('<base href="https://evil.example/">rest of the mail'), 'rest of the mail');
    assert.equal(sanitizeHtml('<meta http-equiv="refresh" content="0"><p>after</p>'), '<p>after</p>');
  });

  it('reports what was neutralized in the detailed API', () => {
    const result = sanitizeHtmlDetailed('<script>alert(1)</script><img src="https://x.example/a.png" onerror="x"><a href="javascript:1">l</a>');
    assert.equal(result.droppedTags.includes('script'), true);
    assert.equal(result.blockedImages, 1);
    assert.ok(result.removedAttributes >= 2);
    assert.match(result.html, /data-blocked-src/);
  });

  it('truncates output at the configured length without leaving broken tags', () => {
    const html = '<div>' + '<p>hello</p>'.repeat(1000) + '</div>';
    const result = sanitizeHtmlDetailed(html, { maxLength: 500 });
    assert.equal(result.truncated, true);
    assert.ok(result.html.length <= 500);
    // No dangling "<" fragment: every "<" has a ">" after it.
    let index = result.html.indexOf('<');
    while (index !== -1) {
      const end = result.html.indexOf('>', index);
      assert.notEqual(end, -1);
      index = result.html.indexOf('<', end + 1);
    }
  });

  it('handles non-string input gracefully', () => {
    assert.equal(sanitizeHtml(null), '');
    assert.equal(sanitizeHtml(undefined), '');
    assert.equal(sanitizeHtml(123), '');
  });

  it('escape helpers escape the dangerous characters', () => {
    assert.equal(escapeAttribute('a"b<c>d&e'), 'a&quot;b&lt;c&gt;d&amp;e');
    assert.equal(escapeText('<b>&'), '&lt;b&gt;&amp;');
  });
});
