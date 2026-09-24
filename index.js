/**
 * HSE Daily Morning Notification Bot
 * 
 * Синхронизация с HSE App X через Google Календарь
 * Расчет логистики: СГ Дубки -> МИЭМ (Строгино)
 * Приоритет «Молодёжки» + резерв через Одинцово
 * Погода утром и ко времени возвращения (днём/вечером)
 * Отправка в Telegram
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { execSync } = require('child_process');

// Загрузка конфигурации
const CONFIG_PATH = path.join(__dirname, 'config.json');
let config = {
  botToken: process.env.TELEGRAM_BOT_TOKEN || '',
  chatId: process.env.TELEGRAM_CHAT_ID || '',
  calendarUrl: process.env.CALENDAR_URL || 'https://calendar.google.com/calendar/ical/geraldinekocurewa661%40gmail.com/private-9c2fb920764d4f09ca984f351d0b8cef/basic.ics',
  city: 'Moscow',
  timings: {
    molodyozhka: {
      walkToBusMin: 10,
      busRideMin: 30,
      metroToStroginoMin: 10,
      walkToMiemMin: 6
    },
    odintsovo: {
      walkToBusMin: 7,
      busRideMin: 15,
      commuteToStroginoMin: 50,
      walkToMiemMin: 6
    }
  }
};

if (fs.existsSync(CONFIG_PATH)) {
  try {
    const loaded = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    config = { ...config, ...loaded };
  } catch (e) {
    console.error('Ошибка чтения config.json:', e.message);
  }
}

// Расписание автобусов (действует с 28.08.2026 г.)
const BUS_SCHEDULES = {
  weekday: {
    // Дубки -> м. Молодёжная
    molodyozhka: [
      '07:00',
      '08:00', '08:10',
      '09:40', '09:50',
      '11:30', '11:40',
      '13:10', '13:20',
      '14:50', '15:00',
      '17:00',
      '18:00', '18:20',
      '19:30', '19:50'
    ],
    // м. Молодёжная -> Дубки (обратные)
    molodyozhkaReturn: [
      '07:30',
      '08:40', '08:50',
      '10:20', '10:30',
      '12:10', '12:20',
      '13:50', '14:00',
      '15:30', '15:40',
      '17:40', '18:40', '19:00',
      '20:10', '20:30'
    ],
    // Дубки -> ст. Одинцово
    odintsovo: [
      '06:45', '07:40', '07:50', '08:00', '08:10', '08:20', '08:30', '08:40', '08:50',
      '09:00', '09:10', '09:20', '09:30', '09:40', '09:50', '10:00', '10:10', '10:20',
      '10:30', '10:40', '11:00', '11:10', '11:20', '11:30', '11:40', '11:50', '12:00',
      '12:10', '12:20', '12:30', '12:40', '12:50', '13:00', '13:20', '13:30', '13:40',
      '13:50', '14:00', '14:10', '14:20', '14:30', '14:50', '15:00', '15:10', '15:40',
      '16:20', '16:30', '16:40', '16:50', '17:00', '17:10', '17:20', '17:30', '17:40',
      '17:50', '18:00', '18:10', '18:20', '18:30', '18:40', '18:50', '19:00', '19:10',
      '19:20', '19:30', '19:40', '19:50', '20:00', '20:10', '20:20', '20:30', '20:40',
      '20:50', '21:00', '21:10', '21:20', '21:30', '21:40', '21:50', '22:00', '22:10',
      '22:20', '22:30', '22:40', '22:50', '23:00', '23:10', '23:20', '23:30'
    ]
  },
  sunday: {
    molodyozhka: [],
    molodyozhkaReturn: [],
    odintsovo: [
      '07:00', '07:30', '08:00', '08:30', '09:00', '09:30', '10:00', '10:30', '11:00',
      '11:30', '12:00', '12:30', '13:00', '14:00', '15:00', '16:00', '17:00', '17:30',
      '18:00', '18:30', '19:00', '19:30', '20:00', '20:30', '21:00', '21:30', '22:00',
      '22:30', '23:00', '23:20', '00:00'
    ]
  }
};

// Сетка пар ВШЭ
const HSE_SLOTS = [
  { num: 1, start: '09:30', end: '10:50' },
  { num: 2, start: '11:10', end: '12:30' },
  { num: 3, start: '13:00', end: '14:20' },
  { num: 4, start: '14:40', end: '16:00' },
  { num: 5, start: '16:20', end: '17:40' },
  { num: 6, start: '18:10', end: '19:30' },
  { num: 7, start: '19:40', end: '21:00' }
];

function timeToMin(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

function minToTime(m) {
  const norm = ((m % 1440) + 1440) % 1440;
  const h = Math.floor(norm / 60).toString().padStart(2, '0');
  const min = (norm % 60).toString().padStart(2, '0');
  return `${h}:${min}`;
}

// Загрузка текста по HTTP/HTTPS (с поддержкой перенаправлений)
function fetchText(urlStr) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.get(urlStr, { timeout: 15000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(fetchText(res.headers.location));
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Timeout: ' + urlStr));
    });
  });
}

// Парсер Google Календаря
async function getClassesForDate(targetDateStr, icsUrl) {
  let content = '';
  try {
    content = await fetchText(icsUrl);
  } catch (err) {
    console.error('Ошибка загрузки календаря онлайн, проверяем локальный кэш...', err.message);
    const backupFile = path.join(__dirname, 'calendar_cache.ics');
    if (fs.existsSync(backupFile)) {
      content = fs.readFileSync(backupFile, 'utf8');
    } else {
      throw err;
    }
  }

  try {
    fs.writeFileSync(path.join(__dirname, 'calendar_cache.ics'), content, 'utf8');
  } catch (_) {}

  const events = [];
  const blocks = content.split('BEGIN:VEVENT');

  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i].split('END:VEVENT')[0];
    const dtstartMatch = block.match(/DTSTART(?:;[^:]+)?:(.*?)\r?\n/);
    if (!dtstartMatch) continue;

    const dtstartRaw = dtstartMatch[1].trim();
    const dtendMatch = block.match(/DTEND(?:;[^:]+)?:(.*?)\r?\n/);
    const dtendRaw = dtendMatch ? dtendMatch[1].trim() : '';

    const summaryMatch = block.match(/SUMMARY:(.*?)(?:\r?\n[A-Z\-]|\r?\nEND)/s);
    const summary = summaryMatch ? summaryMatch[1].replace(/\r?\n /g, '').trim() : 'Пара';

    const locationMatch = block.match(/LOCATION:(.*?)(?:\r?\n[A-Z\-]|\r?\nEND)/s);
    const location = locationMatch ? locationMatch[1].replace(/\r?\n /g, '').trim().replace(/\\,/g, ',') : '';

    const descMatch = block.match(/DESCRIPTION:(.*?)(?:\r?\n[A-Z\-]|\r?\nEND)/s);
    const desc = descMatch ? descMatch[1].replace(/\r?\n /g, '').trim() : '';

    // Перевод в Московское время (UTC+3)
    let year, month, day, hour, minute;
    if (dtstartRaw.endsWith('Z')) {
      const match = dtstartRaw.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
      if (match) {
        const utcDate = new Date(Date.UTC(+match[1], +match[2] - 1, +match[3], +match[4], +match[5], +match[6]));
        const mskDate = new Date(utcDate.getTime() + 3 * 3600 * 1000);
        year = mskDate.getUTCFullYear();
        month = (mskDate.getUTCMonth() + 1).toString().padStart(2, '0');
        day = mskDate.getUTCDate().toString().padStart(2, '0');
        hour = mskDate.getUTCHours().toString().padStart(2, '0');
        minute = mskDate.getUTCMinutes().toString().padStart(2, '0');
      }
    } else {
      const match = dtstartRaw.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})/);
      if (match) {
        year = match[1];
        month = match[2];
        day = match[3];
        hour = match[4];
        minute = match[5];
      }
    }

    if (!year) continue;
    const dateStr = `${year}-${month}-${day}`;
    const startTimeStr = `${hour}:${minute}`;

    let endTimeStr = '';
    if (dtendRaw.endsWith('Z')) {
      const match = dtendRaw.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
      if (match) {
        const utcDate = new Date(Date.UTC(+match[1], +match[2] - 1, +match[3], +match[4], +match[5], +match[6]));
        const mskDate = new Date(utcDate.getTime() + 3 * 3600 * 1000);
        endTimeStr = `${mskDate.getUTCHours().toString().padStart(2, '0')}:${mskDate.getUTCMinutes().toString().padStart(2, '0')}`;
      }
    }

    if (dateStr === targetDateStr) {
      let pairNum = '?';
      const startMin = timeToMin(startTimeStr);
      for (const slot of HSE_SLOTS) {
        const slotMin = timeToMin(slot.start);
        if (Math.abs(slotMin - startMin) <= 15) {
          pairNum = slot.num;
          break;
        }
      }

      let teacher = '';
      const teacherMatch = desc.match(/Преподаватель:\s*([^\\,\n]+)/);
      if (teacherMatch) {
        teacher = teacherMatch[1].trim();
      }

      events.push({
        pairNum,
        startTime: startTimeStr,
        endTime: endTimeStr,
        summary,
        location,
        teacher
      });
    }
  }

  events.sort((a, b) => timeToMin(a.startTime) - timeToMin(b.startTime));
  return events;
}

// Расчет логистики туда
function calculateCommute(firstClassStart, dayOfWeek) {
  const isSunday = dayOfWeek === 0;
  const schedule = isSunday ? BUS_SCHEDULES.sunday : BUS_SCHEDULES.weekday;
  const targetMin = timeToMin(firstClassStart);

  // 1. Приоритетный маршрут — Молодёжка
  let bestMolod = null;
  if (schedule.molodyozhka && schedule.molodyozhka.length > 0) {
    const transitMin = config.timings.molodyozhka.busRideMin + 
                       config.timings.molodyozhka.metroToStroginoMin + 
                       config.timings.molodyozhka.walkToMiemMin; // 30 + 10 + 6 = 46 min

    for (const bus of schedule.molodyozhka) {
      const busMin = timeToMin(bus);
      const arriveMin = busMin + transitMin;
      const leaveMin = busMin - config.timings.molodyozhka.walkToBusMin;
      const spareMin = targetMin - arriveMin;

      if (spareMin >= 0) {
        if (!bestMolod || busMin > bestMolod.busMin) {
          bestMolod = {
            busTime: bus,
            busMin,
            leaveTime: minToTime(leaveMin),
            arriveTime: minToTime(arriveMin),
            spareMin,
            type: 'Молодёжка (комфортный)'
          };
        }
      }
    }
  }

  // 2. Резервный маршрут — через станцию Одинцово
  let bestOdintsovo = null;
  if (schedule.odintsovo && schedule.odintsovo.length > 0) {
    const transitMin = config.timings.odintsovo.busRideMin + 
                       config.timings.odintsovo.commuteToStroginoMin + 
                       config.timings.odintsovo.walkToMiemMin; // 15 + 50 + 6 = 71 min

    for (const bus of schedule.odintsovo) {
      const busMin = timeToMin(bus);
      const arriveMin = busMin + transitMin;
      const leaveMin = busMin - config.timings.odintsovo.walkToBusMin;
      const spareMin = targetMin - arriveMin;

      if (spareMin >= 0) {
        if (!bestOdintsovo || busMin > bestOdintsovo.busMin) {
          bestOdintsovo = {
            busTime: bus,
            busMin,
            leaveTime: minToTime(leaveMin),
            arriveTime: minToTime(arriveMin),
            spareMin,
            type: 'Через Одинцово (запасной)'
          };
        }
      }
    }
  }

  return { bestMolod, bestOdintsovo };
}

// Расчет логистики обратно
function calculateReturn(lastClassEnd, dayOfWeek) {
  const isSunday = dayOfWeek === 0;
  const schedule = isSunday ? BUS_SCHEDULES.sunday : BUS_SCHEDULES.weekday;
  if (!lastClassEnd) return null;

  // МИЭМ -> Строгино (6м) -> Молодёжная (10м) = на Молодёжной через 16 мин
  const reachMolodMin = timeToMin(lastClassEnd) + 16;
  const availableMolod = (schedule.molodyozhkaReturn || []).filter(b => timeToMin(b) >= reachMolodMin);
  const nextMolodBus = availableMolod.length > 0 ? availableMolod[0] : null;

  return {
    reachMolodTime: minToTime(reachMolodMin),
    nextMolodBus
  };
}

// Получение погоды с прогнозом на утро и ко времени возвращения
async function getWeather(returnHour = 15) {
  const weather = {
    morning: null,
    returnTime: null
  };

  const curlCmd = process.platform === 'win32' ? 'curl.exe' : 'curl';

  try {
    // Текущая утренняя погода
    const rawCur = execSync(`${curlCmd} -s "https://wttr.in/Moscow?format=temp:%t,feels:%f,cond:%C,precip:%p&lang=ru"`, { encoding: 'utf8' });
    const parts = {};
    rawCur.trim().split(',').forEach(p => {
      const [k, v] = p.split(':');
      if (k && v) parts[k.trim()] = v.trim();
    });
    weather.morning = {
      temp: parts.temp || '',
      feels: parts.feels || '',
      cond: parts.cond || '',
      precip: parts.precip || '0.0mm'
    };

    // Прогноз на день/вечер
    const tableStr = execSync(`${curlCmd} -s "https://wttr.in/Moscow?1TFq&lang=ru"`, { encoding: 'utf8' });
    const lines = tableStr.split('\n');
    const tempLineIdx = lines.findIndex(l => l.includes('°C') && l.includes('│') && !l.includes('┌'));
    const rainLineIdx = lines.findIndex(l => l.includes('мм') && l.includes('│') && !l.includes('┌'));

    if (tempLineIdx !== -1 && rainLineIdx !== -1) {
      const tempCols = lines[tempLineIdx].split('│').slice(1, 5).map(c => {
        const m = c.match(/([+\-]?\d+(?:\(\d+\))?\s*°C)/);
        return m ? m[1].replace(/\s+/g, '') : '';
      });
      const rainCols = lines[rainLineIdx].split('│').slice(1, 5).map(c => {
        const m = c.match(/(\d+(?:\.\d+)?\s*мм(?:\s*\|\s*\d+%)?)/);
        return m ? m[1].trim() : '';
      });

      // Если возвращаемся до 16:00 — берем "День", если после 16:00 — берем "Вечер"
      const isEvening = returnHour >= 16;
      const periodName = isEvening ? 'Вечером' : 'Днём';
      const periodTemp = isEvening ? tempCols[2] : tempCols[1];
      const periodRain = isEvening ? rainCols[2] : rainCols[1];

      weather.returnTime = {
        periodName,
        temp: periodTemp,
        rain: periodRain
      };
    }
  } catch (err) {
    console.error('Ошибка получения погоды:', err.message);
  }

  return weather;
}

// Формирование красивого сообщения
function buildMessage({ dateStr, dayName, classes, commute, returnInfo, weather }) {
  let msg = `📅 <b>План на ${dayName} (${dateStr}):</b>\n\n`;

  if (classes.length === 0) {
    msg += `🎉 <b>Сегодня пар нет! Можно отдыхать и выспаться!</b> 🥳\n\n`;
    if (weather.morning) {
      msg += `🌤 <b>Погода в Москве:</b> ${weather.morning.cond}, ${weather.morning.temp} (ощущается ${weather.morning.feels}), осадки: ${weather.morning.precip}\n`;
    }
    return msg;
  }

  const first = classes[0];
  const last = classes[classes.length - 1];

  msg += `📍 <b>К КАКОЙ ПАРЕ: к ${first.pairNum}-й паре (в ${first.startTime})</b>\n\n`;

  // Логистика
  msg += `🚌 <b>КАК ДОБИРАТЬСЯ (МАРШРУТ):</b>\n`;
  if (commute.bestMolod) {
    msg += `⭐ <b>Основной — Автобус до м. Молодёжная:</b>\n`;
    msg += `  • ⏰ <b>Выйти из общаги:</b> в <b>${commute.bestMolod.leaveTime}</b> (за 10 мин)\n`;
    msg += `  • 🚏 <b>Автобус «Молодёжка»:</b> в <b>${commute.bestMolod.busTime}</b>\n`;
    msg += `  • 🏛 <b>Прибытие в МИЭМ:</b> ~<b>${commute.bestMolod.arriveTime}</b> <i>(запас: ${commute.bestMolod.spareMin} мин)</i>\n`;
  }

  if (commute.bestOdintsovo) {
    msg += `\n⚠️ <i>Резервный (если проспал Молодёжку, через ст. Одинцово):</i>\n`;
    msg += `  • Выйти из общаги: в <b>${commute.bestOdintsovo.leaveTime}</b>\n`;
    msg += `  • Автобус до Одинцово: в <b>${commute.bestOdintsovo.busTime}</b>\n`;
    msg += `  • Прибытие в МИЭМ: ~<b>${commute.bestOdintsovo.arriveTime}</b>\n`;
  }
  msg += `\n`;

  // Расписание пар
  msg += `📚 <b>РАСПИСАНИЕ ПАР (всего ${classes.length}):</b>\n`;
  classes.forEach((c) => {
    msg += `• <b>${c.pairNum}-я пара (${c.startTime} – ${c.endTime})</b>\n`;
    msg += `  📖 ${c.summary}\n`;
    if (c.location) msg += `  🏢 Ауд.: ${c.location}\n`;
    if (c.teacher) msg += `  👨‍🏫 ${c.teacher}\n`;
    msg += `\n`;
  });

  // Возвращение домой
  if (last.endTime) {
    msg += `🏁 <b>Окончание пар: в ${last.endTime}</b>\n`;
    if (returnInfo && returnInfo.nextMolodBus) {
      msg += `  • До метро Молодёжная доберётесь к ~${returnInfo.reachMolodTime}\n`;
      msg += `  • Ближайшая «Молодёжка» в Дубки: в <b>${returnInfo.nextMolodBus}</b>\n`;
    } else {
      msg += `  • От ст. Одинцово автобусы в Дубки ходят каждые 10 минут.\n`;
    }
    msg += `\n`;
  }

  // Блок погоды
  if (weather.morning || weather.returnTime) {
    msg += `🌤 <b>ПОГОДА В МОСКВЕ:</b>\n`;
    if (weather.morning) {
      msg += `• <b>Утром (сейчас):</b> ${weather.morning.temp} (ощущается ${weather.morning.feels}), ${weather.morning.cond}\n`;
    }
    if (weather.returnTime && weather.returnTime.temp) {
      msg += `• <b>К возвращению (${weather.returnTime.periodName.toLowerCase()}):</b> ${weather.returnTime.temp}, осадки: ${weather.returnTime.rain}\n`;
    }

    // Рекомендации по погоде
    const isRain = (weather.morning && (weather.morning.cond.toLowerCase().includes('дожд') || parseFloat(weather.morning.precip) > 0.3)) ||
                   (weather.returnTime && (weather.returnTime.rain.includes('%') && parseInt(weather.returnTime.rain.split('|')[1]) > 30));
    if (isRain) {
      msg += `\n☔ <i>Внимание: ожидаются осадки — не забудьте взять зонт!</i>\n`;
    }
  }

  return msg;
}

// Отправка в Telegram
async function sendTelegram(text) {
  if (!config.botToken || !config.chatId) {
    console.log('\n--- [ПРЕДПРОСМОТР: ТОКЕН ТЕЛЕГРАМ НЕ ЗАДАН] ---');
    console.log(text.replace(/<[^>]+>/g, ''));
    console.log('---------------------------------------------------\n');
    return false;
  }

  const payload = JSON.stringify({
    chat_id: config.chatId,
    text: text,
    parse_mode: 'HTML'
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${config.botToken}/sendMessage`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      },
      timeout: 10000
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          console.log('✅ Уведомление в Telegram успешно отправлено!');
          resolve(true);
        } else {
          console.error('❌ Ошибка Telegram API:', body);
          resolve(false);
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// Основной запуск
async function run(customDateStr = null) {
  const now = new Date();
  const mskNow = new Date(now.getTime() + (3 * 60 + now.getTimezoneOffset()) * 60 * 1000);

  const yyyy = mskNow.getFullYear();
  const mm = (mskNow.getMonth() + 1).toString().padStart(2, '0');
  const dd = mskNow.getDate().toString().padStart(2, '0');

  const dateStr = customDateStr || `${yyyy}-${mm}-${dd}`;
  const dayOfWeek = customDateStr ? (new Date(customDateStr)).getDay() : mskNow.getDay();
  const dayNames = ['воскресенье', 'понедельник', 'вторник', 'среду', 'четверг', 'пятницу', 'субботу'];
  const dayName = dayNames[dayOfWeek];

  console.log(`Проверка расписания на ${dateStr} (${dayName})...`);

  const classes = await getClassesForDate(dateStr, config.calendarUrl);
  console.log(`Найдено пар: ${classes.length}`);

  let commute = { bestMolod: null, bestOdintsovo: null };
  let returnInfo = null;
  let returnHour = 15;

  if (classes.length > 0) {
    commute = calculateCommute(classes[0].startTime, dayOfWeek);
    const lastClass = classes[classes.length - 1];
    returnInfo = calculateReturn(lastClass.endTime, dayOfWeek);
    if (lastClass.endTime) {
      returnHour = parseInt(lastClass.endTime.split(':')[0], 10);
    }
  }

  const weather = await getWeather(returnHour);

  const message = buildMessage({
    dateStr,
    dayName,
    classes,
    commute,
    returnInfo,
    weather
  });

  await sendTelegram(message);
}

if (require.main === module) {
  const argDate = process.argv[2];
  run(argDate).catch(console.error);
}

module.exports = { run, calculateCommute, getClassesForDate };
