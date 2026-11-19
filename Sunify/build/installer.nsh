; Sunify NSIS özelleştirmeleri (electron-builder, assisted installer)
; Hem kurulum hem kaldırma ekranları Türkçe ve aynı görsel dili kullanır.

!define MUI_FONT "Segoe UI"
!define MUI_FONTSIZE 9

!macro customWelcomePage
  !define MUI_BGCOLOR "17151E"
  !define MUI_TEXTCOLOR "F7F4FF"
  !define MUI_WELCOMEPAGE_TITLE "Sunify'a hoş geldin"
  !define MUI_WELCOMEPAGE_TEXT "Müziğini, çalma listelerini ve senkronize şarkı sözlerini tek yerde keşfet.$\r$\n$\r$\nKurulum, Sunify için gereken tüm bileşenleri içerir. Python veya ek bir ses aracı kurman gerekmez.$\r$\n$\r$\nDevam etmek için İleri'ye tıkla."
  !define MUI_FINISHPAGE_TITLE "Sunify hazır!"
  !define MUI_FINISHPAGE_TEXT "Kurulum tamamlandı. Sunify'ı şimdi açıp müziğinin keyfini çıkarabilirsin."
  !define MUI_FINISHPAGE_RUN_TEXT "Sunify'ı şimdi başlat"
  !insertmacro MUI_PAGE_WELCOME
!macroend

!macro customUnWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "Sunify kaldırılıyor"
  !define MUI_WELCOMEPAGE_TEXT "Sunify bu bilgisayardan kaldırılacak.$\r$\n$\r$\nHesap, ayar ve indirilen müzik verilerini silip silmeyeceğini bir sonraki adımda soracağız.$\r$\n$\r$\nDevam etmek için Kaldır'a tıkla."
  !insertmacro MUI_UNPAGE_WELCOME
!macroend

; Güncelleme sırasında kullanıcı verisi asla silinmez; yalnızca elle kaldırmada sorulur.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "Hesap, ayar ve indirilen müzik verilerin de silinsin mi?$\r$\n$\r$\nHayır dersen verilerin korunur ve Sunify'ı sonradan tekrar kurabilirsin." /SD IDNO IDNO sunifyKeepData
      RMDir /r "$APPDATA\SunifyPlayerData"
    sunifyKeepData:
  ${endIf}
!macroend
