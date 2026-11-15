// metadataCleaner.js
// YouTube ve YouTube Music başlıklarındaki parantez içi çöpleri, ft./feat. bilgilerini,
// kalite ve video etiketlerini temizleyerek LRCLIB için en temiz şarkı ve sanatçı adını çıkarır.

function cleanTrackMetadata(title, artist = '') {
  let cleanedTitle = title || '';
  let cleanedArtist = artist || '';

  // 1. Eğer başlık "Sanatçı - Şarkı" formatındaysa ve sanatçı bilinmiyorsa ayrıştır
  if (
    cleanedTitle.includes(' - ') &&
    (!cleanedArtist ||
      cleanedArtist.toLowerCase().includes('topic') ||
      cleanedArtist.toLowerCase().includes('vevo'))
  ) {
    const parts = cleanedTitle.split(' - ');
    cleanedArtist = parts[0].trim();
    cleanedTitle = parts.slice(1).join(' - ').trim();
  }

  // 2. Parantez ve köşeli parantez içi gürültüleri temizle
  // Örn: (Official Music Video), [Lyric Video], (Visualizer), (Remastered 2021), (Audio), (4K 60fps), (Prod. by ...)
  const noisePatterns = [
    /\s*[\(\[\{](?:official\s*(?:music\s*)?video|official\s*audio|official|audio|visualizer|lyric\s*video|lyrics|clip\s*officiel|video\s*clip|4k|hd|hq|remastered(?:\s*\d+)?|live(?:\s*at\s*.*)?|studio\s*version)[\)\]\}]/gi,
    /\s*[\(\[\{](?:prod\.\s*(?:by)?\s*[^)\]]+)[\)\]\}]/gi,
    /\s*[\(\[\{](?:feat\.|ft\.)\s*[^)\]]+[\)\]\}]/gi,
    /\|.*$/g, // Başlıktaki "| Official ..." tarzı boru ayraçları
    /#[^\s]+/g, // Hashtagler
  ];

  for (const pattern of noisePatterns) {
    cleanedTitle = cleanedTitle.replace(pattern, '');
  }

  // 3. Başlıkta kalan ft. veya feat. kısımlarını kaldır veya düzenle
  cleanedTitle = cleanedTitle.replace(/\s+(?:feat\.|ft\.)\s+.*$/i, '');

  // 4. Sanatçı adındaki " - Topic", "VEVO" gibi son ekleri temizle
  cleanedArtist = cleanedArtist
    .replace(/\s*-\s*Topic$/i, '')
    .replace(/VEVO$/i, '')
    .replace(/\s*Official$/i, '');

  // 5. Fazladan boşlukları ve baştaki/sondaki özel karakterleri kırp
  cleanedTitle = cleanedTitle
    .replace(/\s+/g, ' ')
    .replace(/^["']|["']$/g, '')
    .trim();
  cleanedArtist = cleanedArtist
    .replace(/\s+/g, ' ')
    .replace(/^["']|["']$/g, '')
    .trim();

  return {
    title: cleanedTitle,
    artist: cleanedArtist,
    rawTitle: title,
    rawArtist: artist,
  };
}

module.exports = { cleanTrackMetadata };
