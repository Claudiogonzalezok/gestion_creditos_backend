const TZ = process.env.TZ || 'America/Argentina/Buenos_Aires';

const localDate = (date = new Date()) =>
  date.toLocaleDateString('en-CA', { timeZone: TZ });

module.exports = { localDate };
