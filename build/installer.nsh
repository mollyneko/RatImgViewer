; ============================================================================
; Rat看图王 — NSIS 安装钩子
;
; 重要前提：Windows 8 之后，系统**不允许**安装程序把某个程序「静默」设成默认打开方式
; （微软刻意封死了这条路径，防止软件互相抢关联；这也是为什么很多看图软件装完
;  还是要你自己去「默认应用」里点一下）。
;
; 所以这里只做一件事：把本程序注册成**候选**，让它出现在「打开方式」和
; Win10/11 的「默认应用」列表里。真正的默认选择必须由用户确认
; （程序内「设置」页提供了跳转按钮和分步引导）。
;
; 全部写 HKCU，不需要管理员权限，也不会动别的程序已建立的默认关联。
; ============================================================================

!macro RAT_OTW EXT
  WriteRegStr HKCU "Software\Classes\${EXT}\OpenWithProgids" "RatImageViewer.Image" ""
  WriteRegStr HKCU "Software\RatImageViewer\Capabilities\FileAssociations" "${EXT}" "RatImageViewer.Image"
  WriteRegStr HKCU "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\SupportedTypes" "${EXT}" ""
!macroend

!macro customInstall
  ; ---- ProgID ----
  WriteRegStr HKCU "Software\Classes\RatImageViewer.Image" "" "RatImageViewer Image"
  WriteRegStr HKCU "Software\Classes\RatImageViewer.Image\DefaultIcon" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}",0'
  WriteRegStr HKCU "Software\Classes\RatImageViewer.Image\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'

  ; ---- 出现在鼠标右键「打开方式」菜单 ----
  WriteRegStr HKCU "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\DefaultIcon" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}",0'
  WriteRegStr HKCU "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'

  ; ---- 出现在「默认应用」页面 ----
  WriteRegStr HKCU "Software\RatImageViewer\Capabilities" "ApplicationName" "RatImageViewer"
  WriteRegStr HKCU "Software\RatImageViewer\Capabilities" "ApplicationDescription" "Lightweight high-performance image viewer"
  WriteRegStr HKCU "Software\RatImageViewer\Capabilities" "ApplicationIcon" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\RegisteredApplications" "RatImageViewer" "Software\RatImageViewer\Capabilities"

  ; ---- 逐个扩展名登记为候选 ----
  !insertmacro RAT_OTW ".jpg"
  !insertmacro RAT_OTW ".jpeg"
  !insertmacro RAT_OTW ".jfif"
  !insertmacro RAT_OTW ".png"
  !insertmacro RAT_OTW ".apng"
  !insertmacro RAT_OTW ".webp"
  !insertmacro RAT_OTW ".gif"
  !insertmacro RAT_OTW ".bmp"
  !insertmacro RAT_OTW ".ico"
  !insertmacro RAT_OTW ".svg"
  !insertmacro RAT_OTW ".avif"
  !insertmacro RAT_OTW ".tif"
  !insertmacro RAT_OTW ".tiff"
  !insertmacro RAT_OTW ".cdr"
  !insertmacro RAT_OTW ".cmx"
  !insertmacro RAT_OTW ".psd"
  !insertmacro RAT_OTW ".psb"
  !insertmacro RAT_OTW ".heic"
  !insertmacro RAT_OTW ".heif"
  !insertmacro RAT_OTW ".cr2"
  !insertmacro RAT_OTW ".cr3"
  !insertmacro RAT_OTW ".nef"
  !insertmacro RAT_OTW ".arw"
  !insertmacro RAT_OTW ".dng"
  !insertmacro RAT_OTW ".orf"
  !insertmacro RAT_OTW ".rw2"
  !insertmacro RAT_OTW ".raf"
!macroend

!macro customUnInstall
  ; 只清我们自己写进去的东西。绝不整键删 Software\RegisteredApplications。
  DeleteRegKey HKCU "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}"
  DeleteRegKey HKCU "Software\Classes\RatImageViewer.Image"
  DeleteRegKey HKCU "Software\RatImageViewer"
  DeleteRegValue HKCU "Software\RegisteredApplications" "RatImageViewer"

  DeleteRegValue HKCU "Software\Classes\.jpg\OpenWithProgids" "RatImageViewer.Image"
  DeleteRegValue HKCU "Software\Classes\.jpeg\OpenWithProgids" "RatImageViewer.Image"
  DeleteRegValue HKCU "Software\Classes\.jfif\OpenWithProgids" "RatImageViewer.Image"
  DeleteRegValue HKCU "Software\Classes\.png\OpenWithProgids" "RatImageViewer.Image"
  DeleteRegValue HKCU "Software\Classes\.apng\OpenWithProgids" "RatImageViewer.Image"
  DeleteRegValue HKCU "Software\Classes\.webp\OpenWithProgids" "RatImageViewer.Image"
  DeleteRegValue HKCU "Software\Classes\.gif\OpenWithProgids" "RatImageViewer.Image"
  DeleteRegValue HKCU "Software\Classes\.bmp\OpenWithProgids" "RatImageViewer.Image"
  DeleteRegValue HKCU "Software\Classes\.ico\OpenWithProgids" "RatImageViewer.Image"
  DeleteRegValue HKCU "Software\Classes\.svg\OpenWithProgids" "RatImageViewer.Image"
  DeleteRegValue HKCU "Software\Classes\.avif\OpenWithProgids" "RatImageViewer.Image"
  DeleteRegValue HKCU "Software\Classes\.tif\OpenWithProgids" "RatImageViewer.Image"
  DeleteRegValue HKCU "Software\Classes\.tiff\OpenWithProgids" "RatImageViewer.Image"
  DeleteRegValue HKCU "Software\Classes\.cdr\OpenWithProgids" "RatImageViewer.Image"
  DeleteRegValue HKCU "Software\Classes\.cmx\OpenWithProgids" "RatImageViewer.Image"
  DeleteRegValue HKCU "Software\Classes\.psd\OpenWithProgids" "RatImageViewer.Image"
  DeleteRegValue HKCU "Software\Classes\.psb\OpenWithProgids" "RatImageViewer.Image"
  DeleteRegValue HKCU "Software\Classes\.heic\OpenWithProgids" "RatImageViewer.Image"
  DeleteRegValue HKCU "Software\Classes\.heif\OpenWithProgids" "RatImageViewer.Image"
  DeleteRegValue HKCU "Software\Classes\.cr2\OpenWithProgids" "RatImageViewer.Image"
  DeleteRegValue HKCU "Software\Classes\.cr3\OpenWithProgids" "RatImageViewer.Image"
  DeleteRegValue HKCU "Software\Classes\.nef\OpenWithProgids" "RatImageViewer.Image"
  DeleteRegValue HKCU "Software\Classes\.arw\OpenWithProgids" "RatImageViewer.Image"
  DeleteRegValue HKCU "Software\Classes\.dng\OpenWithProgids" "RatImageViewer.Image"
  DeleteRegValue HKCU "Software\Classes\.orf\OpenWithProgids" "RatImageViewer.Image"
  DeleteRegValue HKCU "Software\Classes\.rw2\OpenWithProgids" "RatImageViewer.Image"
  DeleteRegValue HKCU "Software\Classes\.raf\OpenWithProgids" "RatImageViewer.Image"
!macroend
