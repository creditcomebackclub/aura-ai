const { execFile } = require('child_process');

function runAppleScript(script) {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/osascript', ['-e', script], {
      timeout: 75000,
      maxBuffer: 1024 * 1024,
      // Do not pass API keys or the Blackboard feed token from AURA's process
      // into AppleScript child processes.
      env: Object.fromEntries(Object.entries({
        HOME: process.env.HOME,
        USER: process.env.USER,
        LOGNAME: process.env.LOGNAME,
        TMPDIR: process.env.TMPDIR,
        LANG: process.env.LANG || 'en_US.UTF-8',
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin'
      }).filter(([, value]) => typeof value === 'string' && value))
    }, (error, stdout, stderr) => {
      if (error) {
        console.error('AppleScript Error:', stderr);
        return reject(error);
      }
      resolve(stdout.trim());
    });
  });
}

async function getUnreadEmails() {
  const script = `
    try
      with timeout of 60 seconds
        tell application "Mail"
          set resultStr to ""
          set counter to 0

          set inboxCount to count of messages of inbox
          set scanCount to 50
          if inboxCount < scanCount then set scanCount to inboxCount

          if scanCount > 0 then
            set recentMessages to (messages 1 thru scanCount of inbox)
            repeat with msg in recentMessages
              if read status of msg is false and counter < 10 then
                set msgSender to sender of msg
                set msgSubject to subject of msg
                set msgDate to date received of msg

                try
                  set fullContent to content of msg as string
                  if (count of fullContent) > 200 then
                    set msgContent to (text 1 thru 200 of fullContent) & "..."
                  else
                    set msgContent to fullContent
                  end if
                on error
                  set msgContent to "[Could not read content]"
                end try
                set resultStr to resultStr & "Received: " & msgDate & "\\nFrom: " & msgSender & "\\nSubject: " & msgSubject & "\\nContent Snippet: " & msgContent & "\\n---\\n"
                set counter to counter + 1
              end if
            end repeat
          end if
          
          if resultStr is "" then
            return "No unread emails were found among the 50 most recent inbox messages."
          end if
          return resultStr
        end tell
      end timeout
    on error errMsg number errNum
      if errNum is -1712 then
        error "Apple Mail did not finish the unread-message scan within 60 seconds."
      else
        error "Error reading Apple Mail: " & errMsg
      end if
    end try
  `;
  try {
    return await runAppleScript(script);
  } catch {
    throw new Error("Apple Mail could not be read. Check the Mac's Automation permission for AURA.");
  }
}

async function getTodaysCalendar() {
  const script = `
    set todayDate to current date
    set time of todayDate to 0
    set tomorrowDate to todayDate + (1 * days)
    set dayAfterTomorrowDate to todayDate + (2 * days)
    
    tell application "Calendar"
      set upcomingEvents to ""
      repeat with c in calendars
        try
          set evts to (events of c whose start date is greater than or equal to todayDate and start date is less than dayAfterTomorrowDate)
          repeat with ev in evts
            set upcomingEvents to upcomingEvents & "Event: " & summary of ev & " (Starts: " & start date of ev & ")\\n"
          end repeat
        end try
      end repeat
      if upcomingEvents is "" then
        return "No events scheduled for today."
      end if
      return upcomingEvents
    end tell
  `;
  try {
    return await runAppleScript(script);
  } catch {
    throw new Error("Apple Calendar could not be read. Check the Mac's Automation permission for AURA.");
  }
}

module.exports = {
  getUnreadEmails,
  getTodaysCalendar
};
