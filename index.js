const express = require('express');
const { google } = require('googleapis');
const { DateTime } = require('luxon');

const app = express();
app.use(express.json());

const CLINIC_TZ = 'America/Chicago';

// ---- GOOGLE OAUTH2 ----
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET
);

oauth2Client.setCredentials({
  refresh_token: process.env.GOOGLE_REFRESH_TOKEN
});

const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

// ---- HEALTH CHECK ----
app.get('/', (req, res) => {
  res.json({ message: 'DialPal Vapi Server is running' });
});

// ---- MAIN VAPI TOOL HANDLER ----
app.post('/vapi/tools', async (req, res) => {
  console.log('Raw body:', JSON.stringify(req.body, null, 2));

  const toolCall = req.body?.message?.toolCalls?.[0];

  if (!toolCall) {
    console.log('No tool call found');
    return res.status(200).json({
      results: [{ toolCallId: 'unknown', result: 'Received but could not parse tool call' }]
    });
  }

  const toolCallId = toolCall.id;
  const toolName = toolCall.function.name;
  const args = toolCall.function.arguments;
  const parsedArgs = typeof args === 'string' ? JSON.parse(args) : args;

  console.log(`Tool called: ${toolName}`, parsedArgs);

  try {
    if (toolName === 'cancel_appointment' || toolName === 'manageAppointment' || toolName === 'delete_google_calendar_event') {
      const result = await cancelAppointment(parsedArgs);
      return res.status(200).json({
        results: [{ toolCallId, result }]
      });
    }

    return res.status(200).json({
      results: [{ toolCallId, result: 'Unknown tool' }]
    });

  } catch (err) {
    console.error('Tool error:', err);
    return res.status(200).json({
      results: [{ toolCallId, result: `Error: ${err.message}` }]
    });
  }
});

// ---- CANCEL APPOINTMENT FUNCTION ----
async function cancelAppointment({ patientName, name, date, appointmentDate, appointment_date, appointmentTime, appointment_time }) {
  const calendarId = process.env.GOOGLE_CALENDAR_ID;
  const searchName = patientName || name;
  const searchDate = date || appointmentDate || appointment_date;
  const searchTime = appointmentTime || appointment_time;

  if (!searchName || !searchDate) {
    return 'Missing patient name or date — cannot cancel.';
  }

  // FIX: build the day window in the CLINIC's local timezone (America/Chicago),
  // then convert to UTC for the Calendar API call.
  //
  // The previous version did `new Date(searchDate)` + `.setHours(0,0,0,0)`,
  // which anchors the window to the SERVER's local timezone (UTC on Railway),
  // not Chicago. That silently excluded any appointment where the Chicago
  // local time crosses into the next UTC calendar day — i.e. anything from
  // ~7pm Chicago time onward (7pm CDT = midnight UTC the next day). That's
  // exactly why 7am cancellations worked but 7pm ones returned
  // "no appointment found."
  const dayStart = DateTime.fromISO(searchDate, { zone: CLINIC_TZ }).startOf('day');
  const dayEnd = dayStart.endOf('day');

  const response = await calendar.events.list({
    calendarId,
    timeMin: dayStart.toUTC().toISO(),
    timeMax: dayEnd.toUTC().toISO(),
    singleEvents: true,
    orderBy: 'startTime',
  });

  const events = response.data.items || [];
  console.log(
    `Found ${events.length} events on ${searchDate} ` +
    `(Chicago-local window: ${dayStart.toISO()} to ${dayEnd.toISO()})`
  );

  // Filter by name first
  const nameMatches = events.filter(e =>
    e.summary && e.summary.toLowerCase().includes(searchName.toLowerCase())
  );

  let match;
  if (nameMatches.length === 0) {
    return `No matching appointment was found for ${searchName} on ${searchDate}.`;
  } else if (nameMatches.length === 1) {
    match = nameMatches[0];
  } else if (nameMatches.length > 1 && searchTime) {
    // FIX: compare times as Chicago-local HH:mm instead of doing a raw
    // substring match against whatever offset format Google happens to
    // return. Keeps this correct across DST (CDT vs CST) and regardless of
    // how the event's dateTime string is formatted.
    const targetTime = normalizeTime(searchTime);
    match = nameMatches.find(e => {
      const eventStart = e.start?.dateTime;
      if (!eventStart) return false;
      const eventLocalTime = DateTime.fromISO(eventStart).setZone(CLINIC_TZ).toFormat('HH:mm');
      return eventLocalTime === targetTime;
    });
    if (!match) {
      return `Multiple appointments match this name and date — please confirm the appointment time.`;
    }
  } else {
    return `Multiple appointments match this name and date — please confirm the appointment time.`;
  }

  await calendar.events.delete({
    calendarId,
    eventId: match.id,
    sendUpdates: 'all'
  });

  return `Appointment for ${searchName} on ${searchDate} at ${searchTime || 'the requested time'} was canceled successfully.`;
}

// Normalizes "7:00 PM", "19:00", "7:00pm", etc. into 24-hour "HH:mm" for comparison.
function normalizeTime(raw) {
  const t = raw.trim();
  let parsed = DateTime.fromFormat(t.toUpperCase(), 'h:mm a'); // "7:00 PM"
  if (!parsed.isValid) parsed = DateTime.fromFormat(t, 'HH:mm'); // "19:00"
  return parsed.isValid ? parsed.toFormat('HH:mm') : t;
}

// ---- START SERVER ----
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});