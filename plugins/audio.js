let client = null
const Discord = require( 'discord.js' )

const commands = require( '../commands.js' )
const permissions = require( '../permissions.js' )
const settings = require( '../settings.js' )
const _ = require( '../helper.js' )

const fs = require( 'fs' )
const path = require( 'path' )
const child_process = require( 'child_process' )

const request = require('request')
const youtube_dl = require( 'youtube-dl' )
const ytdl_core = require( 'ytdl-core' )
const ytsr = require( 'ytsr' )
const moment = require( 'moment' )
require( 'moment-duration-format' )

const playlistDir = '../playlists'

const default_youtube_urls =
	[
		'(https?\\:\\/\\/)?(www\\.)?(youtube\\.com|youtu\\.be)\\/.*',
	]

const default_additional_urls =
	[
		'(https?\\:\\/\\/)?(www\\.)?soundcloud.com\\/.*',
		'(https?\\:\\/\\/)?(.*\\.)?bandcamp.com\\/track/.*',
		'(https?\\:\\/\\/)?(www\\.)?vimeo.com\\/.*',
		'(https?\\:\\/\\/)?(www\\.)?vine.co\\/v\\/.*',
		'(https?\\:\\/\\/)?(.*\\.)?twitch.tv\\/.*',
	]

const default_accepted_files =
	[
		'.*\\.mp3',
		'.*\\.ogg',
		'.*\\.wav',
		'.*\\.flac',
		'.*\\.m4a',
		'.*\\.aac',
		'.*\\.webm',
		'.*\\.mp4',
	]

function formatTime( sec )
{
	return moment.duration( sec * 1000 ).format( 'mm:ss', { forceLength: true, trim: false } )
}

let ffmpeg_cmd = false
const audioBots = []
function initAudio()
{
	for ( const dir of [process.cwd()].concat( process.env.PATH.split( path.delimiter ) ) )
	{
		const cmd = `${dir}${path.sep}ffmpeg`
		if ( fs.existsSync( cmd ) )
		{
			ffmpeg_cmd = cmd
			break
		}
	}
	if ( !ffmpeg_cmd )
		return _.log( 'NO FFMPEG FOUND -- audio will not be usable' )
	else
		_.log( 'using ffmpeg: ' + ffmpeg_cmd )

	client.concord_audioSessions = {}
	client.on( 'voiceStateUpdate', ( o, n ) => audioBotMoved( client, o, n ) )
	audioBots.push( client )

	const tokens = settings.get( 'config', 'helper_tokens', [] )
	for ( const i in tokens )
	{
		const tok = tokens[i]

		const cl = new Discord.Client()
		cl.on( 'error', e => _.logError( cl, e ) )

		cl.on( 'ready', e =>
			{
				_.logEvent( cl, 'helper-ready', e )

				const activity = settings.get( 'botactivity', cl.user.id, false )
				if ( activity )
					cl.user.setActivity( activity.message, { type: activity.type } )


				if ( cl.initialized ) return
				cl.initialized = true

				audioBots.push( cl )
				module.exports.numHelpers++
			})

		cl.on( 'disconnect', e =>
			{
				module.exports.numHelpers--
				_.logEvent( cl, 'helper-disconnect', e )
			})
		cl.on( 'reconnecting', e => _.logEvent( cl, 'helper-reconnecting', e ) )
		cl.on( 'resume', e => _.logEvent( cl, 'helper-resume', e ) )

		cl.on( 'guildCreate', e => _.logEvent( cl, 'helper-guildCreate', e ) )
		cl.on( 'guildDelete', e => _.logEvent( cl, 'helper-guildDelete', e ) )
		cl.on( 'guildUnavailable', e => _.logEvent( cl, 'helper-guildUnavailable', e ) )

		cl.on( 'voiceStateUpdate', ( o, n ) => audioBotMoved( cl, o, n ) )

		cl.concord_audioSessions = {}

		setTimeout( ( cl ) =>
			{
				cl.login( tok )
					.catch( e =>
					{
						_.logError( cl, e )
					})
			}, 3000 * (i+1), cl )
	}
}

function audioBotMoved( bot, oldState, newState )
{
	if ( newState.id !== bot.user.id ) return

	const oldChannel = bot.channels.get( oldState.channelID )
	if ( !oldChannel ) return

	const newChannel = bot.channels.get( newState.channelID )
	if ( !newChannel ) return

	let shouldLeave = false
	newChannel.members.forEach( m =>
		{
			if ( m.user.presence.status === 'offline' ) return
			if ( m.user.bot && m.user.id !== bot.user.id )
				shouldLeave = true
		})

	if ( !shouldLeave )
		return
	
	const sess = bot.concord_audioSessions[ oldChannel.guild.id ]
	if ( !sess ) return

	leave_channel( sess )
}

let songTracking = {}
function trackSong( gid, song )
{
	if ( !songTracking[ gid ] )
		songTracking[ gid ] = {}

	let url = song.url
	const regex = /^(.*)(?:&(?:t|v|start|end)=.*)/g.exec( url )
	if ( regex )
		url = regex[1]

	if ( !songTracking[ gid ][ url ] )
	{
		songTracking[ gid ][ url ] = {}
		songTracking[ gid ][ url ].plays = 1
		songTracking[ gid ][ url ].title = song.title
	}
	else
		songTracking[ gid ][ url ].plays++

	settings.save( 'songtracking', songTracking )
}

function findSession( msg )
{
	if ( msg.member.user.presence.status === 'offline' )
		return false
		
	const channel = _.getVoiceChannel( client, msg.member )
	if ( !channel )
		return false

	for ( const bot of audioBots )
	{
		const sess = bot.concord_audioSessions[ channel.guild.id ]

		if ( sess && sess.conn.channel.id === channel.id )
			return sess
	}

	return false
}

const activityCheckDelay = 30 * 1000
function checkSessionActivity()
{
	const timeout = settings.get( 'audio', 'idle_timeout', 60 )

	for ( const bot of audioBots )
	{
		for ( const gid in bot.concord_audioSessions )
		{
			const sess = bot.concord_audioSessions[ gid ]

			if ( !sess )
				continue
			
			if ( !sess.playing && _.time() >= sess.lastActivity + timeout )
			{
				leave_channel( sess )
				continue
			}

			const numVoice = sess.conn.channel.members.filter( m => m.user.presence.status !== 'offline' ).size
			if ( numVoice === 1 )
			{
				leave_channel( sess )
				continue
			}
		}
	}

	setTimeout( checkSessionActivity, activityCheckDelay )
}

function create_session( bot, channel, conn )
{
	const gid = channel.guild.id

	bot.concord_audioSessions[ gid ] = {}
	bot.concord_audioSessions[ gid ].conn = conn

	bot.concord_audioSessions[ gid ].queue = []
	bot.concord_audioSessions[ gid ].volume = settings.get( 'audio', 'volume_default', 0.5 )

	bot.concord_audioSessions[ gid ].guild = gid
	bot.concord_audioSessions[ gid ].bot = bot

	bot.concord_audioSessions[ gid ].lastActivity = _.time()

	return bot.concord_audioSessions[ gid ]
}

function attempt_join( bot, chan, resolve, reject, attempts=0 )
{
	chan.join().then( conn => resolve( create_session( bot, chan, conn ) ) )
		.catch( e =>
			{
				const err = e.message
				if ( attempts <= settings.get( 'audio', 'max_join_attempts', 1 ) && 
					err === 'Connection not established within 15 seconds.' )
						attempt_join( bot, chan, resolve, reject, attempts+1 )
				else
					reject( `error joining channel: \`${ err }\`` )
				
			})
}

function join_channel( msg )
{
	const promise = new Promise( ( resolve, reject ) =>
		{
			const channel = _.getVoiceChannel( client, msg.member )
				
			if ( !channel )
				return reject( 'you are not in a voice channel' )
			
			let success = false
			let botsArray = audioBots
			if ( settings.get( 'audio', 'shuffle_bots', false ) )
				botsArray = _.shuffleArr( audioBots )
			for ( const bot of botsArray )
			{
				const sess = findSession( msg )
				if ( sess )
				{
					sess.lastActivity = _.time()
					return resolve( sess )
				}
				else if ( !sess && !bot.concord_audioSessions[ channel.guild.id ] )
				{
					if ( !channel.permissionsFor( bot.user ).has( Discord.Permissions.FLAGS.CONNECT ) ||
						!channel.permissionsFor( bot.user ).has( Discord.Permissions.FLAGS.SPEAK ) ||
						!channel.permissionsFor( bot.user ).has( Discord.Permissions.FLAGS.USE_VAD ) )
							return reject( _.fmt( 'invalid permissions for `%s`', channel.name ) )

					const guild = bot.guilds.get( channel.guild.id )
					if ( guild )
						guild.channels.filter( c => c.type === 'voice' ).forEach( chan =>
							{
								if ( success ) return
								if ( chan.id === channel.id )
								{
									attempt_join( bot, chan, resolve, reject )
									success = true
									module.exports.numSessions++
								}
							})

					if ( success )
						break
				}
			}

			if ( !success )
				return reject( 'all bots are currently busy in other channels' )
		})
	
	return promise
}

function leave_channel( sess )
{
	sess.closing = true
	sess.playing = false

	if ( sess.ffmpeg )
		sess.ffmpeg.kill( 'SIGKILL' )

	if ( sess.timeInterval )
		clearInterval( sess.timeInterval )

	if ( sess.dispatch )
	{
		stop_playback( sess )
		sess.dispatch.destroy()
	}

	if ( sess.conn.channel )
		sess.conn.channel.leave()

	const bot = sess.bot
	delete bot.concord_audioSessions[ sess.guild ]
	module.exports.numSessions--
}

function stop_playback( sess )
{
	if ( sess.dispatch )
	{
		sess.dispatch.removeAllListeners( 'end' )
		sess.dispatch.end()
	}
}

function skip_playback( sess )
{
	if ( sess.dispatch )
		sess.dispatch.end()
}

function start_player( sess, forceseek )
{
	if ( sess.closing ) return

	if ( sess.ffmpeg )
	{
		sess.ffmpeg.kill( 'SIGKILL' )
		delete sess.ffmpeg
	}

	if ( sess.timeInterval )
		clearInterval( sess.timeInterval )

	sess.playing = false
	if ( sess.dispatch )
	{
		stop_playback( sess )
		sess.dispatch.destroy()
		delete sess.dispatch
	}
	if ( sess.conn.dispatcher )
	{
		sess.conn.dispatcher.destroy()
		delete sess.conn.dispatcher
	}
	
	sess.lastActivity = _.time()
	
	const song = sess.queue[0]
	if ( !song )
		return

	sess.lastSong = song
	trackSong( sess.conn.channel.guild.id, song )
	
	if ( song.channel && typeof forceseek === 'undefined' && !sess.loop )
	{
		let by_user = get_queuedby_user( song )
		if ( sess.queue.length > 1 )
			by_user += `, +${sess.queue.length - 1} in queue`

		if ( !sess.hideNP )
			song.channel.send( _.fmt( '`NOW PLAYING in %s: %s [%s] (%s)`', sess.conn.channel.name, song.title, song.length, by_user ) )
	}
	sess.hideNP = false

	if ( song.channel )
		song.channel.concord_lastSong = song
	
	const guildname = sess.conn.channel.guild.name
	const channelname = sess.conn.channel.name
	_.log( _.fmt( 'playing <%s> in (%s/%s)', song.url, guildname, channelname ) )
	module.exports.songsSinceBoot++

	const params = []
	params.push( '-i', song.streamurl )
	params.push( '-reconnect', '1' )
	params.push( '-reconnect_streamed', '1' )
	params.push( '-reconnect_delay_max', '2' )
	
	sess.skipVotes = []
	sess.paused = false
	
	sess.starttime = 0
	const seek = forceseek || song.seek
	if ( seek )
	{
		sess.starttime = seek
		params.push( '-ss', seek )
	}

	if ( song.volOverride )
	{
		if ( !sess.lastVolume )
			sess.lastVolume = sess.volume
		sess.volume = song.volOverride
	}
	else if ( sess.lastVolume )
	{
		sess.volume = sess.lastVolume
		sess.lastVolume = false
	}

	const volume = sess.volume || settings.get( 'audio', 'volume_default', 0.5 )

	if ( settings.get( 'audio', 'force_speed', false ) )
		params.push( '-re' )

	let filter = `volume=${volume}`
	if ( settings.get( 'audio', 'normalize', true ) )
	{		
		let threshold = settings.get( 'audio', 'comp_threshold', 0.1 ) // 10 ^ ( -dB / 20 )
		const ratio = settings.get( 'audio', 'comp_ratio', 6 )
		const attack = settings.get( 'audio', 'comp_attack', 30 )
		const release = settings.get( 'audio', 'comp_release', 300 )

		let makeup = 1
		if ( volume < 1 )
			threshold *= volume
		else
			makeup = volume
		filter = `acompressor=threshold=${threshold}:ratio=${ratio}:attack=${attack}:release=${release}:makeup=${makeup}`
	}
	const bassboost = settings.get( 'audio', 'bassboost', 3 )
	if ( bassboost > 0 )
		filter += `, bass=g=${bassboost}`

	params.push( '-f', 'opus' )
	params.push( '-acodec', 'libopus' )

	params.push( '-analyzeduration', '0' )
	params.push( '-probesize', settings.get( 'audio', 'probesize', '5000000' ) )

	if ( settings.get( 'audio', 'ffmpeg_direct', true ) )
		params.push( '-avioflags', 'direct' )

	const fflags = settings.get( 'audio', 'fflags', '+fastseek+nobuffer+flush_packets+discardcorrupt' )
	if ( fflags )
		params.push( '-fflags', fflags )
	
	if ( settings.get( 'audio', 'flush_packets', true ) )
		params.push( '-flush_packets', '1' )

	params.push( '-ar', '48000' )
	params.push( '-ac', '2' )

	params.push( '-b:a', sess.conn.channel.bitrate )
	params.push( '-af', filter )
	
	const loglevel = settings.get( 'audio', 'loglevel', 8 )
	params.push( '-loglevel', loglevel )
	params.push( 'pipe:1' )

	//console.log( ffmpeg_cmd, params.join( ' ' ).replace( /&/g, '%26' ) )
	sess.ffmpeg = child_process.spawn( ffmpeg_cmd, params )
	sess.ffmpeg.stderr.on( 'data', e =>
		{
			const err = e.toString()
			if ( song.channel && settings.get( 'audio', 'output_ffmpeg_errors', true ) )
				song.channel.send( 'ffmpeg error:\n```' + err + '```' )
			if ( settings.get( 'audio', 'log_ffmpeg_errors', true ) )
				console.log( `[ffmpeg]  ${err}` )
		})

	const streamType = 'ogg/opus'
	const passes = settings.get( 'audio', 'passes', 2 )
	const fec = settings.get( 'audio', 'fec', true )
	const plp = settings.get( 'audio', 'plp', 1 ) / 100 / 100

	const streamOptions = { type: streamType, passes: passes, 'fec': fec, 'plp': plp }
	sess.dispatch = sess.conn.play( sess.ffmpeg.stdout, streamOptions )

	if ( !sess.conn.dispatcher )
	{
		_.log( `ERROR: could not start encoder with params "${ params.join( ' ' ) }"` )
		leave_channel( sess )
		return
	}
	
	sess.playing = true
	sess.dispatch.once( 'end', () =>
		{
			sess.playing = false
			rotate_queue( sess )
		})

	sess.timeInterval = setInterval( () =>
		{
			sess.lastActivity = _.time()
			sess.time = sess.starttime + ( sess.dispatch.streamTime / 1000 )
			if ( sess.queue[0] && sess.queue[0].endAt && sess.time >= sess.queue[0].endAt )
				skip_playback( sess )
		}, 1000 )
}

function rotate_queue( sess )
{
	if ( sess.closing ) return

	if ( typeof sess.loop === 'undefined' || !sess.loop )
		sess.queue.shift()
	start_player( sess )
}

function get_queuedby_user( song )
{
	let by_user = '<unknown>'
	if ( song.queuedby )
		by_user = _.nick( song.queuedby, song.channel.guild )
	return by_user
}

function queryErr( err )
{
	console.log( _.filterlinks( err ) )
	return _.fmt( 'could not query youtube info (%s)', _.filterlinks( err ) )
}

function exceedsLength( length_seconds )
{
	const max_length = settings.get( 'audio', 'max_length', 62 ) * 60
	if ( length_seconds > max_length )
	{
		const thislen = formatTime( length_seconds )
		const maxlen = formatTime( max_length )
		return _.fmt( 'song exceeds max length: %s > %s', thislen, maxlen )
	}

	return false
}

function parseVars( url )
{
	const songInfo = {}

	songInfo.seek = false
	if ( url.indexOf( 't=' ) !== -1 )
		songInfo.seek = _.parsetime( _.matches( /t=(.+?)(?:&|$)/g, url )[0] )
	if ( url.indexOf( 'start=' ) !== -1 )
		songInfo.seek = _.parsetime( _.matches( /start=(.+?)(?:&|$)/g, url )[0] )

	songInfo.endAt = false
	if ( url.indexOf( 'end=' ) !== -1 )
	{
		const endAt = _.parsetime( _.matches( /end=(.+?)(?:&|$)/g, url )[0] )
		if ( endAt >= 1 )
			songInfo.endAt = endAt
	}

	songInfo.volOverride = false
	if ( url.indexOf( 'vol=' ) !== -1 )
	{
		const v = _.matches( /vol=(.+?)(?:&|$)/g, url )[0]
		if ( !isNaN( v ) )
			songInfo.volOverride = Math.max( 0, Math.min( v, settings.get( 'audio', 'volume_max', 1 ) ) )
	}

	return songInfo
}

function findDesiredBitrate( formats )
{
	const desired_bitrate = parseInt( settings.get( 'audio', 'desired_bitrate', false ) )
	if ( desired_bitrate )
	{
		const format = formats.filter( f => ( parseInt( f.audioBitrate ) === desired_bitrate || parseInt( f.abr ) === desired_bitrate ) )[0]
		if ( format )
			return format.url
	}

	return false
}

function parseLength( url, len_sec, reject )
{
	const songInfo = parseVars( url )

	if ( songInfo.endAt )
		len_sec -= len_sec - songInfo.endAt
	if ( songInfo.seek )
		len_sec -= songInfo.seek
	
	if ( songInfo.seek &&
		( songInfo.endAt && songInfo.seek >= songInfo.endAt ) ||
		( songInfo.seek >= songInfo.length_seconds ) )
		{
			reject( 'cannot play song: start time is beyond end time' )
			return false
		}

	const len_err = exceedsLength( len_sec )
	if ( len_err !== false )
	{
		reject( len_err )
		return false
	}

	songInfo.length = formatTime( len_sec )
	songInfo.length_seconds = len_sec

	return songInfo
}

function parseYoutube( args )
{
	const promise = new Promise(
		( resolve, reject ) =>
		{
			const url = args.url
			const err = args.err
			const info = args.info

			if ( err )
				return reject( queryErr( err ) )

			let songInfo = {}
			songInfo.url = url
			songInfo.title = info.title

			const len_sec = info.length_seconds
			const parsedLen = parseLength( url, len_sec, reject )
			songInfo = Object.assign( parsedLen, songInfo )

			songInfo.streamurl = info.url
			if ( info.formats )
			{
				songInfo.streamurl = info.formats[0].url

				const desiredStream = findDesiredBitrate( info.formats )
				if ( desiredStream )
					songInfo.streamurl = desiredStream
			}

			resolve( songInfo )
		})
	return promise
}

function parseGeneric( args )
{
	const promise = new Promise(
		( resolve, reject ) =>
		{
			const url = args.url
			const err = args.err
			const info = args.info

			if ( err )
				return reject( queryErr( err ) )

			let songInfo = {}
			songInfo.url = url
			songInfo.title = info.title

			songInfo.streamurl = info.url
			if ( info.formats )
			{
				songInfo.streamurl = info.formats[0].url
				
				// skip rtmp links (soundcloud)
				if ( info.formats[0].protocol )
				{
					for ( let i = info.formats.length - 1; i >= 0; i-- )
					{
						if ( info.formats[i].protocol === 'rtmp' )
							info.formats.splice( i, 1 )
						else
							songInfo.streamurl = info.formats[i].url
					}
				}

				const desiredStream = findDesiredBitrate( info.formats )
				if ( desiredStream )
					songInfo.streamurl = desiredStream
			}

			if ( !info.duration )
			{
				probeLength( songInfo.streamurl )
					.then( len_sec => 
						{
							const parsedLen = parseLength( url, len_sec, reject )
							songInfo = Object.assign( parsedLen, songInfo )
							resolve( songInfo )
						})
			}
			else
			{
				const len_sec = info.duration.split(':').reduce( ( acc, time ) => ( 60 * acc ) + +time )
				const parsedLen = parseLength( url, len_sec, reject )
				songInfo = Object.assign( parsedLen, songInfo )
				resolve( songInfo )
			}
		})
	return promise
}

function probeLength( url )
{
	const promise = new Promise(
		( resolve, reject ) =>
		{
			child_process.exec( `ffprobe -v quiet -print_format json -show_format ${ url }`,
				( err, stdout, stderr ) =>
					{
						if ( err )
							return reject( 'ffprobe error: ' + err.toString() )

						const json = JSON.parse( stdout )
						const len_sec = Math.ceil( json.format.duration )

						resolve( len_sec )
					})
		})
	
	return promise
}

function parseFile( url )
{
	const promise = new Promise(
		( resolve, reject ) =>
		{
			let fn = url.split( '/' )
			fn = fn[ fn.length - 1 ]

			let songInfo = {}
			songInfo.url = url
			songInfo.title = fn

			probeLength( url )
				.then( len_sec => 
					{
						const parsedLen = parseLength( url, len_sec, reject )
						songInfo = Object.assign( parsedLen, songInfo )

						songInfo.streamurl = url
						resolve( songInfo )
					})
		})
	return promise
}

function postQuery( songInfo, reject )
{
	return songInfo
}

function queryRemote( url )
{
	const promise = new Promise(
		( resolve, reject ) =>
		{
			const use_ytdl_core = settings.get( 'audio', 'use_ytdl-core', true )
			const youtube_urls = settings.get( 'audio', 'youtube_urls', default_youtube_urls )
			if ( use_ytdl_core )
			{
				for ( const i in youtube_urls )
					if ( url.match( youtube_urls[i] ) )
						return ytdl_core.getInfo( url, { filter: 'audioonly' },
							( err, info ) => 
							{
								parseYoutube( { url, err, info } )
									.then( songInfo => resolve( postQuery( songInfo, reject ) ) )
									.catch( reason => reject( reason ) )
							})
			}
				
			let additional_urls = settings.get( 'audio', 'additional_urls', default_additional_urls )
			if ( !use_ytdl_core )
				additional_urls = Object.assign( [], additional_urls, youtube_urls )

			for ( const i in additional_urls )
				if ( url.match( additional_urls[i] ) )
					return youtube_dl.getInfo( url, [],
						( err, info ) =>
						{
							parseGeneric( { url, err, info } )
								.then( songInfo => resolve( postQuery( songInfo, reject ) ) )
								.catch( reason => reject( reason ) )
						})

			const accepted_files = settings.get( 'audio', 'accepted_files', default_accepted_files )
			for ( const i in accepted_files )
				if ( url.match( accepted_files[i] ) )
				{
					request( { url: url, method: 'HEAD' },
						( error, response ) =>
						{
							if ( !error && response.statusCode === 200 )
								parseFile( url )
									.then( songInfo => resolve( postQuery( songInfo, reject ) ) )
									.catch( reason => reject( reason ) )
							else
								reject( `remote file error ${ error }` )
						})
					return
				}

			console.log( _.fmt( 'ERROR: could not find suitable query mode for <%s>', url ) )
			reject( 'ERROR: could not find suitable query mode' )
		})

	return promise
}

function queueSong( msg, sess, info, interrupt )
{
	info.channel = msg.channel
	info.queuedby = msg.member

	if ( !sess )
		return '`invalid audio session`'
	
	const queue_empty = sess.queue.length === 0

	if ( interrupt )
	{
		sess.queue[0].seek = sess.time
		sess.queue.unshift( info )
	}
	else
		sess.queue.push( info )
	
	if ( queue_empty || interrupt )
	{
		sess.hideNP = true
		start_player( sess )
		return _.fmt( '`%s` started playing `%s [%s]`', _.nick( msg.member, msg.guild ), info.title, info.length )
	}
	else
		return _.fmt( '`%s` queued `%s [%s]`', _.nick( msg.member, msg.guild ), info.title, info.length )
}

function is_accepted_url( link )
{
	const youtube_urls = settings.get( 'audio', 'youtube_urls', default_youtube_urls )
	const additional_urls = settings.get( 'audio', 'additional_urls', default_additional_urls )
	const accepted_files = settings.get( 'audio', 'accepted_files', default_accepted_files )
	
	const acceptedURLs = []
	acceptedURLs.push(...youtube_urls)
	acceptedURLs.push(...additional_urls)
	acceptedURLs.push(...accepted_files)
	
	let found = false
	for ( const i in acceptedURLs )
		if ( link.match( acceptedURLs[i] ) )
			found = true
			
	return found
}

function playURL( url, msg )
{
	join_channel( msg ).then( sess =>
		{
			queryRemote( url ).then( info =>
				{
					msg.channel.send( queueSong( msg, sess, info ) )
				}).catch( err => msg.channel.send( '```' + err + '```' ) )
		})
		.catch( e => { if ( e ) msg.channel.send( e ) } )
}

commands.register( {
	category: 'audio',
	aliases: [ 'play', 'p' ],
	help: 'play audio from a url',
	flags: [ 'no_pm' ],
	args: 'url',
	callback: ( client, msg, args ) =>
	{
		const url = args.replace( /</g, '' ).replace( />/g, '' ) // remove filtering
		if ( !is_accepted_url( url ) )
			return msg.channel.send( _.fmt( '`%s` is not an accepted url', url ) )
		
		playURL( url, msg )
	} })

commands.register( {
	category: 'audio',
	aliases: [ 'immediateplay', 'ip', 'fp', 'forceplay' ],
	help: 'immediately play a url (interrupt current song)',
	flags: [ 'admin_only', 'no_pm' ],
	args: 'url',
	callback: ( client, msg, args ) =>
	{
		args = args.replace( /</g, '' ).replace( />/g, '' ) // remove filtering
		if ( !is_accepted_url( args ) )
			return msg.channel.send( _.fmt( '`%s` is not an accepted url', args ) )
		
		join_channel( msg ).then( sess =>
			{
				queryRemote( args ).then( info =>
					{
						msg.channel.send( queueSong( msg, sess, info, true ) )
					}).catch( err => msg.channel.send( '```' + err + '```' ) )
			})
			.catch( e => { if ( e ) msg.channel.send( e ) } )
	} })

commands.register( {
	category: 'audio',
	aliases: [ 'stop', 'leave', 'l' ],
	help: 'stop the current song & leave the channel',
	flags: [ 'admin_only', 'no_pm' ],
	callback: ( client, msg, args ) =>
	{
		const sess = findSession( msg )
		if ( sess )
			leave_channel( sess )
	} })

function playlistQuery( plurl, msg )
{
	const promise = new Promise(
		( resolve, reject ) =>
		{
			youtube_dl.exec( plurl, [ '--flat-playlist', '-J' ], {},
			( err, output ) =>
				{
					if ( err )
					{
						console.log( _.filterlinks( err ) )
						msg.channel.send( _.fmt( 'could not query info `(%s)`', _.filterlinks( err ) ) )
						return reject()
					}

					const data = []
					const playlist = JSON.parse( output ).entries

					if ( !playlist )
					{
						msg.channel.send( 'invalid remote playlist' )
						return reject()
					}

					for ( const song of playlist )
					{
						const url = `https://www.youtube.com/watch?v=${song.url}`
						if ( !song.title )
						{
							console.log( _.filterlinks( _.fmt( 'malformed playlist, could not find song title for `%s`', song.url ) ) )
							continue
						}
						
						data.push( { url, title: song.title, length: '??:??' } )
					}

					resolve( data )
				})
		})

	return promise
}

commands.register( {
	category: 'audio playlists',
	aliases: [ 'youtubeplaylist', 'ytpl' ],
	help: 'save a youtube playlist for later',
	flags: [ 'no_pm' ],
	args: 'url [name]',
	callback: ( client, msg, args ) =>
	{
		const split = args.split( ' ' )

		const plurl = split[0]
		let plname = split[1]

		if ( !is_accepted_url( plurl ) )
			return msg.channel.send( _.fmt( '`%s` is not an accepted url', plurl ) )

		let savePlaylist = false
		let filePath = ''
		if ( plname )
		{
			savePlaylist = true
			filePath = path.join( __dirname, playlistDir, msg.guild.id + '_' + plname + '.json' )
			if ( fs.existsSync( filePath ) )
				return msg.channel.send( _.fmt( '`%s` already exists', plname ) )
		}
		else
			plname = plurl
		
		msg.channel.send( 'fetching playlist info, please wait...' )
			.then( tempMsg =>
				{
					playlistQuery( plurl, msg )
					.then( data =>
						{

							if ( !savePlaylist )
								queueMultiple( data, msg, plname )
							else
							{
								queryMultiple( data, msg, plname )
									.then( res =>
										{
											fs.writeFileSync( filePath, JSON.stringify( res.queue, null, 4 ), 'utf8' )
											tempMsg.edit( _.fmt( 'saved `%s` songs under `%s`%s', res.queue.length, plname, res.errors ) )
										})
									.catch( errs =>
										{
											return tempMsg.edit( errs.toString() )
										})
							}
						})
				})
	} })

function searchError( tempMsg, chan, err )
{
	tempMsg.edit( `error searching: \`${err}\`` )
	console.error( err )
}

const searchResults = {}
commands.register( {
	category: 'audio',
	aliases: [ 'youtube', 'yt', 'search' ],
	help: 'search youtube',
	flags: [ 'no_pm' ],
	args: 'query',
	callback: ( client, msg, args ) =>
	{
		const chan = _.getVoiceChannel( client, msg.member )
		if ( !chan )
			return msg.channel.send( 'you are not in a voice channel' )

		const query = args
		msg.channel.send( 'searching, please wait...' )
			.then( tempMsg =>
				{
					// 1. create filter for videos only first
					ytsr.getFilters( query, ( err, filters ) =>
						{
							if ( err )
								return searchError( tempMsg, msg.channel, err )

							const filter = filters.get( 'Type' ).find( o => o.name === 'Video' )
							const options =
								{
									limit: settings.get( 'audio', 'max_search_results', 10 ),
									nextpageRef: filter.ref,
								}

							// 2. then run actual search w/ filters passed
							ytsr( null, options, ( err, data ) =>
								{
									if ( err )
										return searchError( tempMsg, msg.channel, err )

									const results = []
									const fields = []
									for ( const i in data.items )
									{
										const song = data.items[i]
										fields.push( { name: `${parseInt(i)+1}. ${song.title} [${song.duration}] (${song.author.name})`, value: song.link } )
										results.push( song.link )
									}

									const prefix = settings.get( 'config', 'command_prefix', '!' )
									const embed = new Discord.MessageEmbed({
										title: `search results for "${query}"`,
										description: `youtube search in \`${chan.name}\``,
										fields: fields,
										footer: { text: `type \`${prefix}playresult #\` or \`${prefix}pr #\` to play a song from your last search` },
									})
									tempMsg.edit( '', embed )
									searchResults[ chan.id ] = results
								})
						})
				})
	} })

commands.register( {
	category: 'audio',
	aliases: [ 'playresult', 'pr' ],
	help: 'play a song from your last search results',
	flags: [ 'no_pm' ],
	args: 'number',
	callback: ( client, msg, args ) =>
	{
		const chan = _.getVoiceChannel( client, msg.member )
		if ( !chan )
			return msg.channel.send( 'you are not in a voice channel' )

		if ( !searchResults[ chan.id ] )
			return msg.channel.send( `no previous search results stored for this channel` )

		const num = parseInt(args)
		if ( isNaN( num ) || num <= 0 || num > settings.get( 'audio', 'max_search_results', 10 ) )
			return msg.channel.send( 'invalid search result number' )

		playURL( searchResults[ chan.id ][num-1], msg )
	} })

commands.register( {
	category: 'audio',
	aliases: [ 'voteskip' ],
	help: 'vote to skip the current song',
	flags: [ 'no_pm' ],
	callback: ( client, msg, args ) =>
	{
		const sess = findSession( msg )
		if ( sess )
		{
			if ( !sess.playing )
				return msg.channel.send( 'not playing anything to skip' )
			
			const channel = _.getVoiceChannel( client, msg.member )
			const samechan = sess.conn.channel.id === channel.id
			if ( !samechan )
				return msg.channel.send( "can't vote to skip from another channel" )
			
			if ( !sess.skipVotes )
				sess.skipVotes = []
			
			if ( sess.skipVotes.indexOf( msg.author.id ) !== -1 )
				return
			
			const current_users = []
			for ( const i in channel.members )
				if ( !channel.members[i].bot )
					current_users.push( channel.members[i].id )
			
			const clean_votes = []
			for ( const i in sess.skipVotes )
				if ( current_users.indexOf( sess.skipVotes[i] ) !== -1 )
					clean_votes.push( sess.skipVotes[i] )
			sess.skipVotes = clean_votes
			
			const votesNeeded = Math.round( current_users.length * settings.get( 'audio', 'skip_percent', 0.6 ) )
			sess.skipVotes.push( msg.author.id )

			const numVotes = sess.skipVotes.length
			
			if ( numVotes >= votesNeeded )
			{
				sess.skipVotes = []
				sess.loop = false
				skip_playback( sess )
				return
			}
			else if ( numVotes % 3 === 1 )
				msg.channel.send( _.fmt( '`%s` voted to skip, votes: `%s/%s`', _.nick( msg.member, msg.guild ), numVotes, votesNeeded ) )
		}
		else
			msg.channel.send( 'nothing is currently playing' )
	} })

commands.register( {
	category: 'audio',
	aliases: [ 'skip', 's', 'forceskip' ],
	help: 'force-skip the current song',
	flags: [ 'no_pm' ],
	callback: ( client, msg, args ) =>
	{
		const sess = findSession( msg )
		if ( sess )
		{
			const song = sess.queue[0]
			if ( !song )
				return msg.channel.send( 'nothing is currently playing' )

			if ( song.queuedby.id === msg.member.id || permissions.hasAdmin( msg.member ) )
			{
				sess.loop = false
				skip_playback( sess )
			}
			else
			{
				const by_user = get_queuedby_user( song )
				msg.channel.send( `you do not have permission to skip this song (queued by \`${by_user}\`)` )
			}
		}
	} })

commands.register( {
	category: 'audio',
	aliases: [ 'restart', 'fixlag' ],
	help: 'restarts the audio stream in case of lag',
	flags: [ 'admin_only', 'no_pm' ],
	callback: ( client, msg, args ) =>
	{
		const sess = findSession( msg )			
		if ( sess )
		{
			if ( !sess.playing ) return
			start_player( sess, sess.time )
		}
		else
			msg.channel.send( 'no audio session found for your channel' )
	} })

commands.register( {
	category: 'audio',
	aliases: [ 'volume', 'v' ],
	help: 'view or change current volume',
	flags: [ 'admin_only', 'no_pm' ],
	args: '[number=0-1]',
	callback: ( client, msg, args ) =>
	{
		const sess = findSession( msg )

		if ( !args )
		{
			if ( !sess )
			{
				const def = settings.get( 'audio', 'volume_default', 0.5 )
				return msg.channel.send( _.fmt( 'no current audio session, default volume is `%s`', def ) )
			}

			const vol = sess.volume
			return msg.channel.send( _.fmt( 'current volume is `%s`', vol ) )
		}
		
		if ( isNaN( args ) )
			return msg.channel.send( _.fmt( '`%s` is not a number', args ) )
		
		const vol = Math.max( 0, Math.min( args, settings.get( 'audio', 'volume_max', 1 ) ) )
		msg.channel.send( _.fmt( '`%s` changed volume to `%s`', _.nick( msg.member, msg.guild ), vol ) )
		
		if ( sess )
		{
			if ( !sess.playing ) return
			
			sess.volume = vol
			start_player( sess, sess.time )
		}
	} })

commands.register( {
	category: 'audio',
	aliases: [ 'title', 'song', 'nowplaying', 'np' ],
	flags: [ 'no_pm' ],
	help: "info about what's currently playing",
	callback: ( client, msg, args ) =>
	{
		const sess = findSession( msg )
		if ( sess )
		{
			if ( !sess.playing ) return msg.channel.send( 'nothing is currently playing' )
			
			const song = sess.queue[0]
			if ( !song )
				return msg.channel.send( 'nothing is currently playing' )
			
			let by_user = get_queuedby_user( song )
			if ( sess.queue.length > 1 )
				by_user += `, +${sess.queue.length - 1} in queue`
			msg.channel.send( _.fmt( '`NOW PLAYING in %s:\n%s [%s] (%s)`\n<%s>', sess.conn.channel.name, song.title, song.length, by_user, song.url ) )
		}
		else
			msg.channel.send( 'nothing is currently playing' )
	} })

commands.register( {
	category: 'audio',
	aliases: [ 'queue', 'q' ],
	flags: [ 'no_pm' ],
	help: 'view the current audio queue',
	callback: ( client, msg, args ) =>
	{
		const sess = findSession( msg )
		if ( sess )
		{
			if ( !sess.playing ) return msg.channel.send( '```\nempty\n```' )
			
			const queue = sess.queue
			if ( queue.length === 0 )
				return msg.channel.send( '```\nempty\n```' )
			
			let total_len = 0
			const fields = []
			for ( const i in queue )
			{
				const song = queue[i]
				total_len += parseInt( song.length_seconds )
				const by_user = get_queuedby_user( song )
				fields.push( { name: _.fmt( '%s. %s [%s] (%s)', parseInt(i) + 1, song.title, song.length, by_user ), value: song.url } )
			}
			
			total_len = formatTime( total_len )

			const embed = new Discord.MessageEmbed({
				title: `${queue.length} songs [${total_len}]`,
				description: '-',
				fields: fields,
			})
			msg.channel.send( '', embed )
		}
		else
			msg.channel.send( '```\nempty\n```' )
	} })

commands.register( {
	category: 'audio',
	aliases: [ 'pause' ],
	flags: [ 'admin_only', 'no_pm' ],
	help: 'pauses the current song',
	callback: ( client, msg, args ) =>
	{
		const sess = findSession( msg )
		if ( sess )
		{
			if ( !sess.playing ) return
			if ( sess.paused ) return
			
			sess.paused = true
			stop_playback( sess )
		}
	} })

commands.register( {
	category: 'audio',
	aliases: [ 'resume' ],
	flags: [ 'admin_only', 'no_pm' ],
	help: 'resumes the current song if paused',
	callback: ( client, msg, args ) =>
	{
		const sess = findSession( msg )
		if ( sess )
		{
			if ( !sess.playing ) return
			if ( !sess.paused ) return
			
			sess.paused = false
			start_player( sess, sess.time )
		}
	} })

commands.register( {
	category: 'audio',
	aliases: [ 'time', 'seek' ],
	help: 'seek to a specific time',
	flags: [ 'admin_only', 'no_pm' ],
	args: '[time]',
	callback: ( client, msg, args ) =>
	{
		const sess = findSession( msg )
		if ( sess )
		{
			if ( !sess.playing ) return
			
			if ( args )
				start_player( sess, _.parsetime( args ) )
			else
			{
				let currentSeek = formatTime( Math.round(sess.time) )
				if ( !currentSeek.match( ':' ) )
					currentSeek = '00:' + currentSeek
	
				msg.channel.send( _.fmt( 'current seek time: `%s / %s`', currentSeek, sess.queue[0].length ) )
			}
		}
	} })

commands.register( {
	category: 'audio',
	aliases: [ 'loop' ],
	help: 'toggle looping of the current song',
	flags: [ 'admin_only', 'no_pm' ],
	callback: ( client, msg, args ) =>
	{
		const sess = findSession( msg )
		if ( sess )
		{
			sess.loop = !sess.loop
			if ( sess.loop )
			{
				msg.channel.send( _.fmt( 'turned on looping, use `%sloop` again to toggle off', settings.get( 'config', 'command_prefix', '!' ) ) )
				if ( sess.lastSong && !sess.playing )
				{
					sess.queue.push( sess.lastSong )
					start_player( sess )
				}
			}
			else
				msg.channel.send( 'turned off looping, queue will proceed as normal' )
		}
	} })

commands.register( {
	category: 'audio',
	aliases: [ 'replay', 'last' ],
	help: 'replay the last song',
	flags: [ 'no_pm' ],
	callback: ( client, msg, args ) =>
	{
		if ( msg.channel.concord_lastSong )
			playURL( msg.channel.concord_lastSong.url, msg )
	} })


function sanitize_filename( str )
{
	return str.replace( /[^a-zA-Z0-9-_]/g, '_' ).trim().toLowerCase()
}

commands.register( {
	category: 'audio playlists',
	aliases: [ 'addtoplaylist', 'pladd' ],
	help: 'add a song to a playlist',
	flags: [ 'admin_only', 'no_pm' ],
	args: 'name url',
	callback: ( client, msg, args ) =>
	{
		const split = args.split( ' ' )
		let name = split[0]
		let link = split[1]
		
		name = sanitize_filename( name )
		if ( !name )
			return msg.channel.send( 'please enter a valid playlist name' )
		
		link = link.replace( /</g, '' ).replace( />/g, '' ) // remove filtering
		if ( !is_accepted_url( link ) )
			return msg.channel.send( _.fmt( '`%s` is not an accepted url', link ) )
		
		const filePath = path.join( __dirname, playlistDir, msg.guild.id + '_' + name + '.json' )
		
		let data = []
		if ( fs.existsSync( filePath ) )
		{
			const playlist = fs.readFileSync( filePath, 'utf8' )
			if ( !_.isjson( playlist ) )
				return msg.channel.send( 'error in `%s`, please delete', name )
			data = JSON.parse( playlist )
		}
		
		queryRemote( link ).then( info =>
			{
				delete info.streamurl

				data.push( info )
				fs.writeFileSync( filePath, JSON.stringify( data, null, 4 ), 'utf8' )
				msg.channel.send( _.fmt( '`%s` added `%s [%s]` to `%s`', _.nick( msg.member, msg.guild ), info.title, info.length, name ) )
			})
			.catch( s => msg.channel.send( '```' + s + '```' ) )
	} })

function queryMultiple( data, msg, name )
{
	const promise = new Promise( ( resolve, reject ) =>
	{
		const max = settings.get( 'audio', 'max_playlist', 50 )
		if ( data.length > max )
			return reject( _.fmt( 'playlist exceeds max playlist length: `%s` > `%s`', data.length, max ) )
		
		const numSongs = data.length
		let numLoaded = 0
		let numErrors = 0
		let errors = ''
		let tempMsg = null
		const queueBuffer = []

		function checkLoaded( i )
		{
			numLoaded++
			if ( numLoaded >= numSongs )
			{
				if ( numErrors > 0 )
					errors = _.fmt( '\n```error loading %s song(s) in %s:\n%s```', numErrors, name, errors )

				if ( tempMsg )
					tempMsg.delete()

				if ( numErrors >= numLoaded )
					return reject( errors )

				return resolve( { queue: queueBuffer, errors: errors } )
			}
			else
				queryPlaylist( i + 1 )
		}

		function queryPlaylist( i )
		{
			const song = data[i]
			if ( !is_accepted_url( song.url ) )
			{
				errors += _.fmt( '<%s>: not an accepted url\n', song.url )
				numErrors++
				checkLoaded( i )
				return
			}
			
			queryRemote( song.url ).then( info =>
				{
					queueBuffer.push( info )
					checkLoaded( i )
				})
			.catch( s =>
				{
					errors += _.fmt( '<%s>: %s\n', song.url, s )
					numErrors++
					checkLoaded( i )
				})
		}
		
		if ( numSongs > 1 )
		{
			msg.channel.send( _.fmt( 'fetching info for `%s` song(s), please wait...', numSongs ) ).then( m =>
			{
				tempMsg = m
				queryPlaylist( 0 )
			})
		}
		else
			queryPlaylist( 0 )
	})

	return promise
}

function queueMultiple( data, msg, name )
{
	join_channel( msg ).then( res =>
	{
		const sess = res

		function do_rest( firstSong, errors )
		{
			data.shift()
			if ( data.length === 0 )
			{
				if ( errors !== '' )
					msg.channel.send( errors )
				return
			}
			
			queryMultiple( data, msg, name ).then( res =>
				{
					const queueBuffer = res.queue
					errors += res.errors

					if ( firstSong )
						queueBuffer.unshift( firstSong )
	
					const queue_empty = sess.queue.length === 0
					if ( queue_empty )
						sess.hideNP = true
	
					const verb = queue_empty ? 'started playing' : 'queued'
					const confirmation = _.fmt( '`%s` %s `%s`%s', _.nick( msg.member, msg.guild ), verb, name, errors )
					
					let total_len = 0
					const fields = []
					for ( const i in queueBuffer )
					{
						const song = queueBuffer[i]
						song.channel = msg.channel
						song.queuedby = msg.member

						total_len += parseInt( song.length_seconds )
						fields.push( { name: _.fmt( '%s. %s [%s]', parseInt(i) + 1, song.title, song.length ), value: song.url } )
					}
	
					total_len = formatTime( total_len )

					
					const embed = new Discord.MessageEmbed({
						title: `${queueBuffer.length} songs [${total_len}]`,
						description: '-',
						fields: fields,
					})
					msg.channel.send( confirmation, embed )
					
					queueBuffer.shift()
					sess.queue.push(...queueBuffer)
					if ( queue_empty )
						start_player( sess )
				})
				.catch( errs =>
				{
					return msg.channel.send( errs )
				})
		}
		queryRemote( data[0].url ).then( info =>
			{
				msg.channel.send( queueSong( msg, sess, info ) )
				do_rest( info, '' )
			}).catch( s => do_rest( false, s + '\n' ) )
	})
	.catch( e => { if ( e ) msg.channel.send( e ) } )
}

commands.register( {
	category: 'audio playlists',
	aliases: [ 'loadplaylist', 'lp' ],
	help: 'load a playlist into the queue',
	flags: [ 'no_pm' ],
	args: 'name',
	callback: ( client, msg, args ) =>
	{
		const name = sanitize_filename( args )
		if ( !name )
			return msg.channel.send( 'please enter a valid playlist name' )
		
		const filePath = path.join( __dirname, playlistDir, msg.guild.id + '_' + name + '.json' )
		if ( !fs.existsSync( filePath ) )
			return msg.channel.send( _.fmt( '`%s` does not exist', name ) )
		
		const playlist = fs.readFileSync( filePath, 'utf8' )
		if ( !_.isjson( playlist ) )
			return msg.channel.send( 'error in `%s`, please delete', name )

		const data = JSON.parse( playlist )
		queueMultiple( data, msg, name )
	} })

commands.register( {
	category: 'audio playlists',
	aliases: [ 'playlists', 'playlist', 'list' ],
	help: 'list playlists, or songs in a playlist',
	flags: [ 'no_pm' ],
	args: '[name]',
	callback: ( client, msg, args ) =>
	{
		const normalizedPath = path.join( __dirname, playlistDir )
		if ( !args )
		{
			let list = ''
			fs.readdirSync( normalizedPath ).forEach( ( file ) => {
					if ( !file.endsWith( '.json' ) ) return
					if ( !file.startsWith( msg.guild.id + '_' ) ) return

					let playlistCount = ''
					if ( settings.get( 'audio', 'show_playlist_count', true ) ) playlistCount = ' (' + JSON.parse(fs.readFileSync(path.join(normalizedPath, file))).length + ')'

					list += file.replace( '.json', '' ).replace( msg.guild.id + '_', '' ) + playlistCount + ', '
				})
			msg.channel.send( '```--- playlists ---\n' + list.substring( 0, list.length - 2 ) + '```' )
		}
		else
		{
			const name = sanitize_filename( args )
			if ( !name )
				return msg.channel.send( 'please enter a valid playlist name' )
			
			const filename = msg.guild.id + '_' + name + '.json'
			const filePath = path.join( __dirname, playlistDir, filename )
			
			if ( !fs.existsSync( filePath ) )
				return msg.channel.send( _.fmt( '`%s` does not exist', name ) )
			
			const playlist = fs.readFileSync( filePath, 'utf8' )
			if ( !_.isjson( playlist ) )
				return msg.channel.send( 'error in `%s`, please delete', name )
			
			let total_len = 0
			const fields = []
			const data = JSON.parse( playlist )
			for ( const i in data )
			{
				const song = data[i]
				total_len += parseInt( song.length_seconds )
				fields.push( { name: _.fmt( '%s. %s [%s]', parseInt(i) + 1, song.title, song.length ), value: song.url } )
			}
			
			total_len = formatTime( total_len )

			const embed = new Discord.MessageEmbed({
				title: `${data.length} songs [${total_len}]`,
				description: '-',
				fields: fields,
			})
			msg.channel.send( '', embed )
		}
	} })

commands.register( {
	category: 'audio playlists',
	aliases: [ 'copyplaylist' ],
	help: 'copy a playlist to a different name',
	flags: [ 'admin_only', 'no_pm' ],
	args: 'old new',
	callback: ( client, msg, args ) =>
	{
		const split = args.split( ' ' )
		let oldName = split[0]
		let newName = split[1]
		
		oldName = sanitize_filename( oldName )
		newName = sanitize_filename( newName )
		if ( !oldName || !newName )
			return msg.channel.send( 'please enter valid playlist names' )
		
		const oldPath = path.join( __dirname, playlistDir, msg.guild.id + '_' + oldName + '.json' )
		const newPath = path.join( __dirname, playlistDir, msg.guild.id + '_' + newName + '.json' )
		
		if ( !fs.existsSync( oldPath ) )
			return msg.channel.send( _.fmt( '`%s` does not exist', oldName ) )
		
		if ( fs.existsSync( newPath ) )
			return msg.channel.send( _.fmt( '`%s` already exists', newName ) )
		
		fs.createReadStream( oldPath ).pipe( fs.createWriteStream( newPath ) )
		msg.channel.send( _.fmt( '`%s` has been copied to `%s`', oldName, newName ) )
	} })

commands.register( {
	category: 'audio playlists',
	aliases: [ 'deleteplaylist' ],
	help: 'delete a playlist',
	flags: [ 'admin_only', 'no_pm' ],
	args: 'name',
	callback: ( client, msg, args ) =>
	{
		const name = sanitize_filename( args )
		if ( !name )
			return msg.channel.send( 'please enter a valid playlist name' )
		
		const filePath = path.join( __dirname, playlistDir, msg.guild.id + '_' + name + '.json' )
		if ( !fs.existsSync( filePath ) )
			return msg.channel.send( _.fmt( '`%s` does not exist', name ) )
		
		fs.unlinkSync( filePath )
		msg.channel.send( _.fmt( '`%s` deleted', name ) )
	} })

commands.register( {
	category: 'audio',
	aliases: [ 'audiostats' ],
	help: 'display audio stats for this guild',
	flags: [ 'admin_only', 'no_pm' ],
	callback: ( client, msg, args ) =>
	{
		const gid = msg.guild.id
		if ( !(gid in songTracking) )
			return msg.channel.send( 'no audio data found for this server' )

		const sorted = Object.keys( songTracking[ gid ] )
		sorted.sort( (a, b) => { return songTracking[ gid ][b].plays - songTracking[ gid ][a].plays } )

		const fields = []
		for ( const url of sorted )
		{
			if ( fields.length > 10 ) break
			const song = songTracking[ gid ][ url ]
			const plays = song.plays
			const title = song.title
			fields.push( { name: `${ fields.length + 1 }. [${ plays } plays] ${ title }`, value: url } )
		}

		const embed = new Discord.MessageEmbed({
			title: `top 10 songs`,
			description: '-',
			fields: fields,
		})
		msg.channel.send( '', embed )
	} })

module.exports.setup = _cl => {
    client = _cl
	_.log( 'loaded plugin: audio' )
	
	initAudio()
	checkSessionActivity()
	songTracking = settings.get( 'songtracking', null, {} )
}

module.exports.songsSinceBoot = 0
module.exports.numSessions = 0
module.exports.numHelpers = 0
module.exports.audioBots = audioBots
