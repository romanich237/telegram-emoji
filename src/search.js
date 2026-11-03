function normalize(value) {
  return String(value || '').toLocaleLowerCase('ru').replace(/ё/g, 'е').trim();
}

function searchEmojis(rows, query, limit = 30) {
  const q = normalize(query);
  if (!q) return rows.slice(0, limit).map(row => ({ ...row, score: 0 }));

  return rows.map(row => {
    const emoji = normalize(row.emoji);
    const description = normalize(row.description);
    let score = 0;
    if (emoji === q) score += 100;
    if (emoji.includes(q) || q.includes(emoji) && emoji) score += 35;
    if (description === q) score += 90;
    if (description.includes(q)) score += 70;
    for (const token of q.split(/\s+/).filter(Boolean)) {
      if (description.includes(token)) score += 12;
      if (emoji.includes(token)) score += 8;
    }
    return { ...row, score };
  }).filter(row => row.score > 0).sort((a, b) => b.score - a.score).slice(0, limit);
}

module.exports = { searchEmojis };