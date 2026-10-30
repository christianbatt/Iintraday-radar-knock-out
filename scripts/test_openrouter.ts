import dotenv from 'dotenv';
dotenv.config();

const apiKey = process.argv[2] || process.env.OPENROUTER_API_KEY || '';

if (!apiKey) {
  console.error('[ERRORE] Nessuna chiave API OpenRouter fornita.');
  console.log('Utilizzo: npx tsx scripts/test_openrouter.ts <OPENROUTER_API_KEY>');
  console.log('Oppure imposta OPENROUTER_API_KEY nel file .env');
  process.exit(1);
}

const masked = apiKey.length > 14 
  ? `${apiKey.slice(0, 10)}...${apiKey.slice(-4)}`
  : '***';

console.log(`[TEST OPENROUTER] Avvio verifica con chiave: ${masked}`);

const models = [
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'deepseek/deepseek-chat',
  'openrouter/free',
];

async function runTest() {
  let passedCount = 0;

  for (const model of models) {
    console.log(`\n--> Test modello: ${model}...`);
    const t0 = Date.now();
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey.trim()}`,
          'HTTP-Referer': process.env.APP_URL || 'https://aistudio.google.com',
          'X-Title': 'Intraday Radar Test',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages: [
            {
              role: 'system',
              content: 'Sei un assistente di test. Rispondi solo in JSON: {"status": "ok", "modello": "..."}',
            },
            {
              role: 'user',
              content: 'Esegui ping test.',
            },
          ],
          response_format: { type: 'json_object' },
          temperature: 0.1,
        }),
      });

      const elapsed = Date.now() - t0;
      if (!res.ok) {
        const errText = await res.text();
        console.error(`[FALLITO] HTTP ${res.status} (${elapsed}ms): ${errText.slice(0, 200)}`);
      } else {
        const data = await res.json();
        const content = data.choices?.[0]?.message?.content;
        console.log(`[SUCCESSO] HTTP 200 (${elapsed}ms). Risposta: ${content}`);
        passedCount++;
      }
    } catch (err: any) {
      console.error(`[ERRORE DI RETE]: ${err.message || err}`);
    }
  }

  console.log(`\n================================`);
  console.log(`Risultato finale: ${passedCount}/${models.length} modelli operativi.`);
  if (passedCount > 0) {
    console.log('ESITO: CHIAVE VALIDA E OPERATIVA');
    process.exit(0);
  } else {
    console.log('ESITO: TEST FALLITO O MODELLI NON DISPONIBILI');
    process.exit(2);
  }
}

runTest();
