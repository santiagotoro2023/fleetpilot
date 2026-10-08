# @@APP_NAME@@: additions to the installer (blueprint core in installer/core/).
# This file is pasted into @@APP_ID@@-install.sh between the core's options and its actions.
# Keep it empty unless @@APP_NAME@@ really needs more; additions are part of the
# installer specification, see .blueprint/spec/04-installer.md.
#
# Optional: runs at the end of every install and update, after nginx was reloaded.
# app_after_install() {
#   ok "Something specific to @@APP_NAME@@"
# }
