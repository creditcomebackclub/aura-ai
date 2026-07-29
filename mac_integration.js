const { exec } = require('child_process');

function runAppleScript(script) {
  return new Promise((resolve, reject) => {
    // Escape double quotes and wrap in single quotes for the bash command
    const command = `osascript -e '${script.replace(/'/g, "'\\''")}'`;
    exec(command, (error, stdout, stderr) => {
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
      with timeout of 10 seconds
        tell application "Mail"
          set resultStr to ""
          set counter to 0
          
          try
            set recentMessages to (messages 1 thru 50 of inbox)
          on error
            set recentMessages to (every message of inbox)
          end try
          
          repeat with msg in recentMessages
            if read status of msg is false then
              if counter < 10 then
                set msgSender to sender of msg
                set msgSubject to subject of msg
                
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
                set resultStr to resultStr & "From: " & msgSender & "\\nSubject: " & msgSubject & "\\nContent Snippet: " & msgContent & "\\n---\\n"
                set counter to counter + 1
              end if
            end if
          end repeat
          
          if resultStr is "" then
            return "No unread emails."
          end if
          return resultStr
        end tell
      end timeout
    on error errMsg number errNum
      if errNum is -1712 then
        return "Your Apple Mail app is currently busy syncing (likely downloading your new Gmail accounts). Please wait a few minutes for it to finish syncing and try again!"
      else
        return "Error reading Apple Mail: " & errMsg
      end if
    end try
  `;
  try {
    return await runAppleScript(script);
  } catch (e) {
    return "Error reading Apple Mail. Please ensure you clicked 'Allow' if prompted for permissions on your Mac.";
  }
}

async function getTodaysCalendar() {
  const script = `
    set todayDate to current date
    set time of todayDate to 0
    set tomorrowDate to todayDate + (1 * days)
    
    tell application "Calendar"
      set upcomingEvents to ""
      repeat with c in calendars
        try
          set evts to (events of c whose start date is greater than or equal to todayDate and start date is less than tomorrowDate)
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
  } catch (e) {
    return "Error reading Apple Calendar. Please ensure you clicked 'Allow' if prompted for permissions on your Mac.";
  }
}

module.exports = {
  getUnreadEmails,
  getTodaysCalendar
};
