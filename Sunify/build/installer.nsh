; Sunify NSIS özelleştirmeleri (electron-builder, assisted installer)
; Hem kurulum hem kaldırma ekranları Türkçe ve modern koyu sıvı cam renk paletini kullanır.

!define MUI_FONT "Segoe UI"
!define MUI_FONTSIZE 9
!define MUI_BGCOLOR "12101B"
!define MUI_TEXTCOLOR "F5F3FF"
!define MUI_HEADER_TRANSPARENT_TEXT

!macro customHeader
  !define MUI_WELCOMEFINISHPAGE_BITMAP_NOSTRETCH
  !define MUI_UNWELCOMEFINISHPAGE_BITMAP_NOSTRETCH
!macroend

!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE_3LINES
  !define MUI_WELCOMEPAGE_TITLE "Sunify'a Hoş Geldin"
  !define MUI_WELCOMEPAGE_TEXT "Hece hece senkronize şarkı sözleri, akıllı öneriler ve masaüstü mini oynatıcı ile müziğini yeni bir seviyeye taşı.$\r$\n$\r$\n• Tüm ses ve şarkı sözü motorları kuruluma dahildir.$\r$\n• Ek Python veya eklenti kurulumu gerektirmez.$\r$\n$\r$\nKurulumu başlatmak için İleri'ye tıkla."
  !define MUI_FINISHPAGE_TITLE_3LINES
  !define MUI_FINISHPAGE_TITLE "Sunify Kuruluma Hazır!"
  !define MUI_FINISHPAGE_TEXT "Sunify bilgisayarınıza başarıyla kuruldu.$\r$\n$\r$\nArtık müziğinin, Günlük Mixlerin ve canlı şarkı sözlerinin tadını çıkarabilirsin."
  !define MUI_FINISHPAGE_RUN_TEXT "Sunify'ı şimdi başlat"
  !insertmacro MUI_PAGE_WELCOME
!macroend

!macro customUnWelcomePage
  !define MUI_WELCOMEPAGE_TITLE_3LINES
  !define MUI_WELCOMEPAGE_TITLE "Sunify Kaldırılıyor"
  !define MUI_WELCOMEPAGE_TEXT "Sunify bu bilgisayardan kaldırılacak.$\r$\n$\r$\nHesap, ayar ve indirilen müzik verilerinin korunup korunmayacağını bir sonraki adımda seçebilirsin.$\r$\n$\r$\nDevam etmek için Kaldır'a tıkla."
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
