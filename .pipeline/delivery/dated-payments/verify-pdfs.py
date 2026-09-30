from pathlib import Path
import re
import sys
import pdfplumber

root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path.cwd() / 'test-output'
for language in ('fr', 'en'):
    with pdfplumber.open(root / f'payments-{language}-test.pdf') as pdf:
        assert len(pdf.pages) == 1
        text = pdf.pages[0].extract_text()
        dates = ('18/09/2026', '25/09/2026') if language == 'fr' else ('2026-09-18', '2026-09-25')
        for date in dates:
            assert date in text, f'Missing payment date {date}'
        amounts = ('40,25', '15,50', '55,75', '231,69') if language == 'fr' else ('40.25', '15.50', '55.75', '231.69')
        for amount in amounts:
            assert amount in text, f'Missing amount {amount}'
        assert '30,00' not in text and '$30.00' not in text, 'Legacy deposit counted again'

with pdfplumber.open(root / 'payments-long-test.pdf') as pdf:
    text = '\n'.join(page.extract_text() or '' for page in pdf.pages)
    rows = re.findall(r'^\d{2}/09/2026\s+([0-9 ,]+)\s*\$', text, re.M)
    assert len(rows) == 90, f'Expected 90 printed payments, found {len(rows)}'
    assert [float(v.replace(' ', '').replace(',', '.')) for v in rows] == list(range(1, 91))
    assert 'Note 48' in text and '4 095,00' in text
    for page in pdf.pages:
        assert (page.width, page.height) == (612, 792)
        for word in page.extract_words():
            assert word['x0'] >= 0 and word['x1'] <= 612, 'Text outside Letter page'
            if word['top'] < 738:
                assert word['bottom'] <= 737, 'Body text collides with footer'
    print(f'PDF_PAYMENT_CONTENT_OK copies=2 payments=90 pages={len(pdf.pages)} notes=48')
