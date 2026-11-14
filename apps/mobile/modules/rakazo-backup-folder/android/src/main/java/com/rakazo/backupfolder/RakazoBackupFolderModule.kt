package com.rakazo.backupfolder

import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class RakazoBackupFolderModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("RakazoBackupFolder")

    AsyncFunction("pick") { _: Map<String, Int>, promise: Promise ->
      // AOSP FileSystemProvider uses listFilesOrEmpty: failed enumeration can
      // look like a successful empty cursor, even without EXTRA_ERROR/LOADING.
      // Tree-count metadata also skips failed visits. Repeating either query is
      // not a completeness proof. No supported trustworthy reader exists yet.
      // Keep this an explicit failure; do not return cancellation or a partial tree.
      promise.reject("folder_inventory_unverifiable", "folder_inventory_unverifiable", null)
    }
  }
}
