#!/bin/tclsh

# The CCU's add-on page calls ?cmd=check_version&version=<installed> and shows the plain
# text answer as the available version; ?cmd=download opens the download page.
# The latest GitHub release (prereleases excluded) is the source, its tag is v<version>.
# The CCU compares the answer with the version of the rc.d script as plain text and reports an
# update when they differ, so an installed pre-release would be offered the older release for
# ever: the answer is the installed version unless the release is newer than it.
set version_url "https://api.github.com/repos/bloop16/homekit-ccu/releases/latest"
set package_url "https://github.com/bloop16/homekit-ccu/releases/latest"
set rcd_script "/usr/local/etc/config/rc.d/homekit-ccu"

# --- version logic (checked by test/111_update_check_cgi.js) ---
# the numbers of a version before any suffix: 0.1.4-rc.1 -> 0 1 4
proc version_numbers {version} {
  set numbers {}
  if { [regexp {^[0-9]+(\.[0-9]+)*} $version base] } {
    foreach part [split $base .] {
      lappend numbers [scan $part %d]
    }
  }
  return $numbers
}

proc is_prerelease {version} {
  return [regexp {^[0-9]+(\.[0-9]+)*-} $version]
}

# 1 when version a is newer than version b: the numbers decide, with the same numbers a release
# is newer than a pre-release of it
proc is_newer {a b} {
  set na [version_numbers $a]
  set nb [version_numbers $b]
  set count [expr {max([llength $na], [llength $nb])}]
  for {set i 0} {$i < $count} {incr i} {
    set x [expr {$i < [llength $na] ? [lindex $na $i] : 0}]
    set y [expr {$i < [llength $nb] ? [lindex $nb $i] : 0}]
    if { $x > $y } { return 1 }
    if { $x < $y } { return 0 }
  }
  return [expr {[is_prerelease $b] && ![is_prerelease $a]}]
}

# what the CCU is told: the release when it is newer than the installed version, else the
# installed version itself (no update); without an installed version the release
proc update_answer {installed release} {
  if { $installed != "" && ![is_newer $release $installed] } {
    return $installed
  }
  return $release
}
# --- end of version logic ---

# Only cmd is read; other parameters (version, ...) are ignored so a query string can never
# change the URLs above or any other variable of this script.
set cmd ""
catch {
  regexp {(?:^|&)cmd=([^&]*)} $env(QUERY_STRING) -> cmd
}

if { $cmd == "download" } {
  puts -nonewline "Content-Type: text/html; charset=utf-8\r\n\r\n"
  puts -nonewline "<html><head><meta http-equiv='refresh' content='0; url=$package_url' /></head><body></body></html>"
} else {
  puts -nonewline "Content-Type: text/plain; charset=utf-8\r\n\r\n"
  catch {
    # the answer is shown as HTML in the add-on list and wget skips certificate checks,
    # so only a version-shaped tag is passed on
    set json [ exec /usr/bin/wget -qO- --no-check-certificate $version_url ]
    regexp {"tag_name"\s*:\s*"v([0-9][0-9A-Za-z.+-]*)"} $json -> newversion
  }
  if { [info exists newversion] } {
    # the installed version is read from the rc.d script (VER=, as the CCU reads it), never from
    # the request
    set installed ""
    catch {
      set fh [open $rcd_script r]
      set head [read $fh 8192]
      close $fh
      regexp -line {^VER=([0-9][0-9A-Za-z.+-]*)$} $head -> installed
    }
    puts [update_answer $installed $newversion]
  } else {
    puts "n/a"
  }
}
