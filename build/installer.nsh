!macro customWelcomePage
  !define MUI_BGCOLOR "12111A"
  !define MUI_TEXTCOLOR "F7F4FF"
  !define MUI_WELCOMEPAGE_TITLE "Sunify'a hoş geldin"
  !define MUI_WELCOMEPAGE_TEXT "Müziğini, çalma listelerini ve senkronize şarkı sözlerini tek yerde keşfet.$\r$\n$\r$\nKurulum Sunify için gereken uygulama bileşenlerini içerir. Python veya ek ses aracı kurman gerekmez.$\r$\n$\r$\nDevam etmek için İleri'ye tıkla."
  !define MUI_FINISHPAGE_TITLE "Sunify hazır!"
  !define MUI_FINISHPAGE_TEXT "Kurulum tamamlandı. Sunify'ı şimdi açıp müziğinin keyfini çıkarabilirsin."
  !define MUI_FINISHPAGE_RUN_TEXT "Sunify'ı şimdi başlat"
  !insertmacro MUI_PAGE_WELCOME
!macroend
