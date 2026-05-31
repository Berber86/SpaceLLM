const fs = require('fs');

// Функция для обновления файла
function updateFile(filename, exampleText, insertionPoint) {
    if (!fs.existsSync(filename)) {
        console.log(`File ${filename} not found!`);
        return;
    }
    
    let content = fs.readFileSync(filename, 'utf8');

    // 1. Заменяем модель
    const modelRegex = /const HYDRA_MODEL\s*=\s*".*?";/g;
    if (modelRegex.test(content)) {
        content = content.replace(modelRegex, 'const HYDRA_MODEL   = "minimax-m2.7";');
        console.log(`Model updated to minimax-m2.7 in ${filename}`);
    } else {
        console.log(`Could not find HYDRA_MODEL declaration in ${filename}`);
    }

    // 2. Вставляем пример в промпт
    if (content.includes(insertionPoint) && !content.includes('ПРИМЕР ОЖИДАЕМОГО ОТВЕТА:')) {
        content = content.replace(insertionPoint, exampleText + '\n\n' + insertionPoint);
        console.log(`Example injected into ${filename}`);
    } else {
        console.log(`Insertion point not found or example already exists in ${filename}`);
    }

    fs.writeFileSync(filename, content);
}

// ---------------------------------------------------------
// 1. FORGE.JS
// ---------------------------------------------------------
const forgeExample = `ПРИМЕР ОЖИДАЕМОГО ОТВЕТА:
\`\`\`json
{
  "name": "Грузовой отсек «Свиная Бездна»",
  "description": "Спрессованные титановые листы, сваренные вкривь и вкось. Трюм стал больше, но эта хрень весит как мамонт, так что скорость полёта упала до скорости дохлой улитки. Плюс топливо жрёт не в себя.",
  "flavor": "Бортжурнал Пилот_01: Впихнул еще пару тонн руды.\\nТеперь корыто еле ползет.\\nЕсли встречу пиратов, просто выкину этот балласт им в морду."
}
\`\`\``;

updateFile('forge.js', forgeExample, 'Отвечай ТОЛЬКО валидным JSON.');


// ---------------------------------------------------------
// 2. WORKSHOP.JS
// ---------------------------------------------------------
const workshopExample = `ПРИМЕР ОЖИДАЕМОГО ОТВЕТА:
\`\`\`json
{
  "name": "Топливный бак «Кровавый Симбиот» Mk.2",
  "description": "Сплав генератора щита и старого бака. Я пустил излишки энергии прямо в топливную магистраль. Ёмкость выросла до небес, но утечки такие, что скоро мы тут все задохнемся от паров изотопов.",
  "flavor": "Бортжурнал Пилот_01: Ебучая химера работает.\\nВоняет страшно.\\nЗато щит теперь питается от испарений. Посмотрим, что ебанет первым."
}
\`\`\``;

updateFile('workshop.js', workshopExample, 'Отвечай ТОЛЬКО валидным JSON.');


// ---------------------------------------------------------
// 3. COMBAT_DECK.JS
// ---------------------------------------------------------
const deckExample = `ПРИМЕР ОЖИДАЕМОГО ОТВЕТА:
\`\`\`json
[
  {
    "origin_key": "art_12345",
    "card_name": "Ржавый таран",
    "lore_description": "Я направляю свой нос прямо в брюхо этому ублюдку. Двигатели воют, металл скрежещет, но мы сближаемся на дистанцию удара.",
    "chaos_reason": "Из-за форсажа перегорел предохранитель, и тормозные двигатели включились на полную мощность вместо маршевых, отбросив нас назад.",
    "actions": [
      { "type": "DISTANCE_PULL", "mult": 1.4, "role": "normal" },
      { "type": "HULL_BRACE", "mult": 1.1, "role": "normal" },
      { "type": "DISTANCE_PUSH", "mult": 0.3, "role": "chaos" }
    ]
  }
]
\`\`\``;

updateFile('combat_deck.js', deckExample, 'ACTION_TYPES (все допустимые):');

