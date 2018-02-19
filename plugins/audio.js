const commands = require( '../commands.js' )
const permissions = require( '../permissions.js' )
const settings = require( '../settings.js' )
const _ = require( '../helper.js' )

const fs = require( 'fs' )
const path = require( 'path' )

const Discordie = require( 'discordie' )
const request = require('request')
const ydl = require( 'youtube-dl' )
const ytdl_core = require( 'ytdl-core' )
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

const audioBots = []
function initAudio()
{
	client.concord_audioSession = false
	audioBots.push( client )

	const tokens = settings.get( 'config', 'helper_tokens', [] )
	for ( const i in tokens )
	{
		const tok = tokens[i]

		const cl = new Discordie( { autoReconnect: true } )
		cl.connect( { token: tok } )

		cl.Dispatcher.on( 'GATEWAY_READY', e =>
			{
				_.log( _.fmt( 'connected helper bot %s#%s <@%s>', cl.User.username, cl.User.discriminator, cl.User.id ) )
			})

		cl.Dispatcher.onAny( ( type, e ) =>
			{
				if ( [ 'GATEWAY_RESUMED', 'DISCONNECTED', 'GUILD_UNAVAILABLE', 'GUILD_CREATE', 'GUILD_DELETE' ].includes(type) )
				{
					let message = e.error || e.guildId || ''
					if ( e.guild )
						message = e.guild.id
					return _.log('helper-' + i + ': <' + type + '> ' + message )
				}
			})

		cl.concord_audioSession = false
		audioBots.push( cl )
	}
}

songTracking = {}
function trackSong( gid, song )
{
	if ( !songTracking[ gid]  )
		songTracking[ gid ] = {}

	if ( !songTracking[ gid ][ song.url ] )
	{
		songTracking[ gid ][ song.url ] = {}
		songTracking[ gid ][ song.url ].plays = 1
		songTracking[ gid ][ song.url ].title = song.title
		songTracking[ gid ][ song.url ].length_seconds = song.length_seconds
	}
	else
		songTracking[ gid ][ song.url ].plays++

	settings.save( 'songtracking', songTracking )
}

function findBot( msg )
{
	const channel = msg.member.getVoiceChannel()
	for ( const i in audioBots )
	{
		const bot = audioBots[i]
		const sess = bot.concord_audioSession

		if ( sess &&
			sess.conn.guild == channel.guild.id &&
			sess.conn.channel == channel.id )
		{
			return bot
		}
	}

	return false
}

function checkSessionActivity()
{
	const timeout = settings.get( 'audio', 'idle_timeout', 60 )

	for ( const i in audioBots )
	{
		const bot = audioBots[i]
		const sess = bot.concord_audioSession

		if ( !sess )
			continue
		
		if ( !sess.playing && _.time() >= sess.lastActivity + timeout )
		{
			leave_channel( bot )
			continue
		}

		if ( sess.playing )
		{
			const numVoice = sess.conn.channel.members.length
			if ( numVoice == 1 )
			{
				leave_channel( bot )
				continue
			}
		}
	}

	setTimeout( checkSessionActivity, 30 * 1000 )
}

function create_session( bot, channel, conn )
{
	bot.concord_audioSession = {}
	bot.concord_audioSession.conn = conn.voiceConnection

	bot.concord_audioSession.queue = []
	bot.concord_audioSession.volume = settings.get( 'audio', 'volume_default', 0.5 )

	return bot
}

function join_channel( msg )
{
	const promise = new Promise( ( resolve, reject ) =>
		{
			const channel = msg.member.getVoiceChannel()
				
			if ( !channel )
				return reject( 'you are not in a voice channel' )
			
			let success = false
			for ( const i in audioBots )
			{
				const bot = audioBots[i]
				const sess = bot.concord_audioSession

				if ( sess &&
					sess.conn.guild == channel.guild.id &&
					sess.conn.channel == channel.id )
				{
					return resolve( bot )
				}
				else if ( !sess )
				{
					if ( !bot.User.can( permissions.discord.Voice.CONNECT, channel ) ||
						!bot.User.can( permissions.discord.Voice.SPEAK, channel ) ||
						!bot.User.can( permissions.discord.Voice.USE_VAD, channel ) )
							return reject( _.fmt( 'invalid permissions for `%s`', channel.name ) )

					const guild = bot.Guilds.get( channel.guild.id )
					for ( const c in guild.voiceChannels )
					{
						const chan = guild.voiceChannels[c]
						if ( chan.id == channel.id )
						{
							chan.join().then( conn => resolve( create_session( bot, chan, conn ) ) )
								.catch( e => reject( `error joining channel: \`${ e.message }\`` ) )
							success = true
							break
						}
					}

					if ( success )
						break
				}
			}

			if ( !success )
				return reject( 'all bots are currently busy in other channels' )
		})
	
	return promise
}

function leave_channel( bot )
{
	const sess = bot.concord_audioSession

	if ( sess.playing )
	{
		sess.encoder.stop()
		sess.encoder.destroy()
	}

	if ( sess.conn.channel )
		sess.conn.channel.leave()

	bot.concord_audioSession = false
}

function rotate_queue( bot )
{
	const sess = bot.concord_audioSession
	if ( typeof sess.loop === 'undefined' || !sess.loop )
		sess.queue.shift()
	start_player( bot )
}

function get_queuedby_user( song )
{
	let by_user = '<unknown>'
	if ( song.queuedby )
		by_user = _.nick( song.queuedby )
	return by_user
}

function start_player( bot, forceseek )
{
	const sess = bot.concord_audioSession
	if ( sess.playing )
	{
		sess.encoder.stop()
		sess.encoder.destroy()
		sess.playing = false
	}
	
	sess.lastActivity = _.time()
	
	const song = sess.queue[0]
	if ( !song )
		return

	sess.lastSong = song
	trackSong( sess.conn.guild.id, song )
	
	if ( song.channel && typeof forceseek === 'undefined' && !sess.loop )
	{
		let by_user = get_queuedby_user( song )
		if ( sess.queue.length > 1 )
			by_user += `, +${sess.queue.length - 1} in queue`

		if ( !sess.hideNP )
			song.channel.sendMessage( _.fmt( '`NOW PLAYING in %s: %s [%s] (%s)`', sess.conn.channel.name, song.title, song.length, by_user ) )
	}
	sess.hideNP = false
	
	const guildname = sess.conn.guild.name
	_.log( _.fmt( 'playing <%s> in (%s)', song.url, guildname ) )
	module.exports.songsSinceBoot++
	
	sess.skipVotes = []
	sess.paused = false
	
	sess.starttime = 0
	const seek = forceseek || song.seek
	let inputArgs = []
	if ( seek )
	{
		sess.starttime = seek
		inputArgs = [ '-ss', seek ]
	}
	
	const volume = sess.volume || settings.get( 'audio', 'volume_default', 0.5 )
	
	if ( sess.encoder )
		delete sess.encoder

	let filter = `volume=${volume}`
	if ( settings.get( 'audio', 'normalize', true ) )
	{
		const I = settings.get( 'audio', 'norm_target', -24 )
		const TP = settings.get( 'audio', 'https://www.youtube.com/watch?v=ocW3fBqPQkUnorm_maxpeak', -2 )
		const LRA = settings.get( 'audio', 'norm_range', 7 )

		let offset = 10 * Math.log( volume ) / Math.log( 2 )
		if ( offset < -99 || offset === -Infinity )
			offset = -99
		if ( offset > 99 || offset === Infinity )
			offset = 99

		filter = `loudnorm=I=${I}:TP=${TP}:LRA=${LRA}:offset=${offset}`
	}

	const encoder = sess.conn.createExternalEncoder(
		{
			type: 'ffmpeg',
			source: song.streamurl,
			format: 'opus',
			inputArgs: inputArgs.concat( [ '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '2' ] ),
			outputArgs: [ '-af', filter ],
		})
		
	if ( !encoder )
		return _.log( 'WARNING: voice connection is disposed' )
	
	sess.playing = true
	sess.encoder = encoder
	encoder.once( 'end', () => rotate_queue( bot ) )

	const encoderStream = encoder.play()
	encoderStream.resetTimestamp()
	encoderStream.removeAllListeners( 'timestamp' )
	encoderStream.on( 'timestamp', time =>
		{
			sess.lastActivity = _.time()
			sess.time = sess.starttime + time
			if ( sess.queue[0] && sess.queue[0].endAt && sess.time >= sess.queue[0].endAt )
				rotate_queue( bot )
		})
}

function queryRemote( args )
{
	const msg = args.msg
	const url = args.url
	const bot = args.bot
	const returnInfo = args.returnInfo
	const forPlaylist = args.forPlaylist
	const quiet = args.quiet
	
	const promise = new Promise( ( resolve, reject ) => {
			const doQuery = tempMsg => {
                function parseInfo( err, info )
                {
                    if ( err )
                    {
                        console.log( _.filterlinks( err ) )
                        if ( !quiet )
                        	if ( tempMsg ) tempMsg.delete()
                        return reject( _.fmt( 'could not query info (%s)', _.filterlinks( err ) ) )
                    }
                    
                    const title = info.title
                    
					let length_seconds = 0
                    let length = '??:??'
                    if ( info.duration && info.duration !== 'NaN' )
                    {
                        const split = info.duration.split( ':' )
                        if ( split.length === 1 )
                            split.unshift( '00' )
                        if ( split.length === 2 )
                            split.unshift( '00' )
                        
                        length = _.fmt( '%s:%s:%s', _.pad( _.round(split[0]), 2 ), _.pad( _.round(split[1]), 2 ), _.pad( _.round(split[2]), 2 ) )
                        length_seconds = moment.duration( length ).format( 'ss' )
                        
                        if ( length.substring( 0, 3 ) === '00:' )
                            length = length.substring( 3 )
                        
                        const max_length = settings.get( 'audio', 'max_length', 62 ) * 60
                        if ( length_seconds > max_length )
                        {
                            const maxlen = moment.duration( max_length * 1000 ).format( 'h:mm:ss' )
                            if ( tempMsg ) tempMsg.delete()
                            return reject( _.fmt( 'song exceeds max length: %s > %s', length, maxlen ) )
                        }
                    }
                    
                    let streamurl = info.url
                    if ( info.formats )
                    {
                        streamurl = info.formats[0].url
                        
                        // skip rtmp links (soundcloud)
                        if ( info.formats[0].protocol )
                        {
                            for ( let i = info.formats.length - 1; i >= 0; i-- )
                            {
                                if ( info.formats[i].protocol === 'rtmp' )
                                    info.formats.splice( i, 1 )
                                else
                                    streamurl = info.formats[i].url
                            }
                        }
                        
                        const desired_bitrate = settings.get( 'audio', 'desired_bitrate', false )
                        if ( desired_bitrate )
                        {
                            let closest = info.formats[0]
                            let diff = 9999
                            for ( const i in info.formats )
                            {
                                const format = info.formats[i]
                                const abr = format.abr || format.audioBitrate
                                const d = Math.abs( desired_bitrate - abr )
                                if ( d < diff )
                                {
                                    closest = format
                                    diff = d
                                }
                            }
                            streamurl = closest.url
                        }
                        else
                        {
                            if ( info.formats[0].abr )
                                streamurl = info.formats.sort( (a, b) => b.abr - a.abr )[0].url
                            if ( info.formats[0].audioBitrate )
                                streamurl = info.formats.sort( (a, b) => b.audioBitrate - a.audioBitrate )[0].url
                        }
                    }
                    
                    let seek = false
                    if ( url.indexOf( 't=' ) !== -1 )
                        seek = _.parsetime( _.matches( /t=(.*)/g, url )[0] )
                    if ( url.indexOf( 'start=' ) !== -1 )
                        seek = _.parsetime( _.matches( /start=(.*)/g, url )[0] )

                    let endAt = false
                    if ( url.indexOf( 'end=' ) !== -1 )
                        endAt = _.parsetime( _.matches( /end=(.*)/g, url )[0] )
                    
                    if ( tempMsg ) tempMsg.delete()
                    const songInfo = { url, title, length, seek, endAt, length_seconds }
                    if ( !forPlaylist )
                    {
                        songInfo.streamurl = streamurl
                        songInfo.queuedby = msg.member
                    }
                    if ( returnInfo )
                        return resolve( songInfo )
                    
                    // never return this
                    songInfo.channel = msg.channel
					
					const sess = bot.concord_audioSession
                    if ( !sess )
                        return reject( 'invalid audio session' )
                    
                    const queue_empty = sess.queue.length === 0
                    sess.queue.push( songInfo )
                    
                    if ( queue_empty )
                    {
                        resolve( _.fmt( '`%s` started playing `%s [%s]`', _.nick( msg.member ), title, length ) )
						sess.hideNP = true
						start_player( bot, 0 )
                    }
                    else
                        resolve( _.fmt( '`%s` queued `%s [%s]`', _.nick( msg.member ), title, length ) )
                }
                
                function parseInfoFast( err, info )
                {
                    if ( info )
                        info.duration = moment.duration( parseInt( info.length_seconds ) * 1000 ).format( 'hh:mm:ss' )
                    parseInfo( err, info )
                }
                
                const accepted_files = settings.get( 'audio', 'accepted_files', default_accepted_files )
                for ( const i in accepted_files )
                    if ( url.match( accepted_files[i] ) )
                    {
                        let fn = url.split('/')
                        fn = fn[ fn.length - 1 ]
                        
                        request( url, ( error, response, body ) => {
                            if ( !error && response.statusCode === 200 )
                                parseInfo( false, { title: fn, url } )
                            else
                            {
                                if ( tempMsg ) tempMsg.delete()
                                reject( 'remote file does not exist' )
                            }
                        })
                        
                        return
                    }
                    
                const youtube_urls = settings.get( 'audio', 'youtube_urls', default_youtube_urls )
                for ( const i in youtube_urls )
                    if ( url.match( youtube_urls[i] ) )
                        return ytdl_core.getInfo( url, parseInfoFast )
                    
                const additional_urls = settings.get( 'audio', 'additional_urls', default_additional_urls )
                for ( const i in additional_urls )
                    if ( url.match( additional_urls[i] ) )
                        return ydl.getInfo( url, [], parseInfo )
                    
                if ( tempMsg ) tempMsg.delete()
                console.log( _.fmt( 'WARNING: could not find suitable query mode for <%s>', url ) )
                return reject( 'could not find suitable query mode' )
            }
			
			doQuery()
		})
		
	return promise
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

commands.register( {
	category: 'audio',
	aliases: [ 'play', 'p' ],
	help: 'play audio from a url',
	flags: [ 'no_pm' ],
	args: 'url',
	callback: ( client, msg, args ) =>
	{
		args = args.replace( /</g, '' ).replace( />/g, '' ) // remove filtering
		if ( !is_accepted_url( args ) )
			return msg.channel.sendMessage( _.fmt( '`%s` is not an accepted url', args ) )
		
		join_channel( msg ).then( res =>
			{				
				queryRemote( { msg, url: args, bot: res } ).then( s => msg.channel.sendMessage( s ) ).catch( s => msg.channel.sendMessage( '```' + s + '```' ) )
			})
			.catch( e => { if ( e.message ) throw e; msg.channel.sendMessage( e ) } )
	} })

commands.register( {
	category: 'audio',
	aliases: [ 'immediateplay', 'ip', 'fp', 'forceplay' ],
	help: 'immediately play a url (skip current song)',
	flags: [ 'admin_only', 'no_pm' ],
	args: 'url',
	callback: ( client, msg, args ) =>
	{
		args = args.replace( /</g, '' ).replace( />/g, '' ) // remove filtering
		if ( !is_accepted_url( args ) )
			return msg.channel.sendMessage( _.fmt( '`%s` is not an accepted url', args ) )
		
		join_channel( msg ).then( res =>
			{
				const sess = res.concord_audioSession
				if ( sess.playing )
					sess.queue = []

				queryRemote( { msg, url: args, bot: res } ).then( s => msg.channel.sendMessage( s ) ).catch( s => msg.channel.sendMessage( '```' + s + '```' ) )
			})
			.catch( e => { if ( e.message ) throw e; msg.channel.sendMessage( e ) } )
	} })

commands.register( {
	category: 'audio',
	aliases: [ 'stop', 's', 'leave' ],
	help: 'stop the currently playing audio',
	flags: [ 'admin_only', 'no_pm' ],
	callback: ( client, msg, args ) =>
	{
		const bot = findBot( msg )
		if ( bot )
			leave_channel( bot )
	} })

commands.register( {
	category: 'audio playlists',
	aliases: [ 'youtubeplaylist', 'ytpl' ],
	help: 'queue up a youtube playlist & optionally save it',
	flags: [ 'no_pm' ],
	args: 'url [name]',
	callback: ( client, msg, args ) =>
	{
		const split = args.split( ' ' )
		if ( !is_accepted_url( split[0] ) )
			return msg.channel.sendMessage( _.fmt( '`%s` is not an accepted url', split[0] ) )
		
		function playlistQuery( tempMsg )
		{
			ydl.exec( split[0], [ '--flat-playlist', '-J' ], {},
			( err, output ) =>
				{
                    tempMsg.delete()

                    if ( err )
					{
						console.log( _.filterlinks( err ) )
						return msg.channel.sendMessage( _.fmt( 'could not query info `(%s)`', _.filterlinks( err ) ) )
					}

                    const data = []
                    const playlist = JSON.parse( output ).entries

                    if ( !playlist )
						return msg.channel.sendMessage( 'invalid remote playlist' )

					for ( const song of playlist )
					{
                        const url = `https://www.youtube.com/watch?v=${song.url}`
                        if ( !song.title )
							return msg.channel.sendMessage( _.fmt( 'malformed playlist, could not find song title for `%s`', song.url ) )
                        data.push( { url, title: song.title, length: '??:??' } )
                    }

                    let name = args
                    if ( split[1] )
					{
						name = split[1]
						const filePath = path.join( __dirname, playlistDir, msg.guild.id + '_' + name + '.json' )
						if ( fs.existsSync( filePath ) )
							return msg.channel.sendMessage( _.fmt( '`%s` already exists', name ) )
						
						queryMultiple( data, msg, name ).then( res =>
							{
								fs.writeFileSync( filePath, JSON.stringify( res.queue, null, 4 ), 'utf8' )
								msg.channel.sendMessage( _.fmt( 'saved `%s` songs under `%s`%s', res.queue.length, name ), res.errors )
							}).catch( errs =>
							{
								return msg.channel.sendMessage( errs )
							})
					}
                })
		}
		
		msg.channel.sendMessage( 'fetching playlist info, please wait...' ).then( tempMsg => playlistQuery( tempMsg ) )
	} })

commands.register( {
	category: 'audio',
	aliases: [ 'voteskip' ],
	help: 'vote to skip the current song',
	flags: [ 'no_pm' ],
	callback: ( client, msg, args ) =>
	{
		const bot = findBot( msg )
		if ( bot )
		{
			const sess = bot.concord_audioSession
			if ( !sess.playing )
				return msg.channel.sendMessage( 'not playing anything to skip' )
			
			const channel = msg.member.getVoiceChannel()
			const samechan = sess.conn.channel.id === channel.id
			if ( !samechan )
				return msg.channel.sendMessage( "can't vote to skip from another channel" )
			
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
				return rotate_queue( bot )
			}
			else if ( numVotes % 3 === 1 )
				msg.channel.sendMessage( _.fmt( '`%s` voted to skip, votes: `%s/%s`', _.nick( msg.member ), numVotes, votesNeeded ) )
		}
		else
			msg.channel.sendMessage( 'nothing is currently playing' )
	} })

commands.register( {
	category: 'audio',
	aliases: [ 'skip', 'forceskip' ],
	help: 'force-skip the current song',
	flags: [ 'admin_only', 'no_pm' ],
	callback: ( client, msg, args ) =>
	{		
		const bot = findBot( msg )
		if ( bot )
			rotate_queue( bot )
	} })

commands.register( {
	category: 'audio',
	aliases: [ 'volume', 'v' ],
	help: 'view or change current volume',
	flags: [ 'admin_only', 'no_pm' ],
	args: '[number=0-1]',
	callback: ( client, msg, args ) =>
	{		
		const bot = findBot( msg )

		if ( !args )
		{
			if ( !bot )
			{
				const def = settings.get( 'audio', 'volume_default', 0.5 )
				return msg.channel.sendMessage( _.fmt( 'no current audio session, default volume is `%s`', def ) )
			}

			const vol = bot.concord_audioSession.volume
			return msg.channel.sendMessage( _.fmt( 'current volume is `%s`', vol ) )
		}
		
		if ( isNaN( args ) )
			return msg.channel.sendMessage( _.fmt( '`%s` is not a number', args ) )
		
		const vol = Math.max( 0, Math.min( args, settings.get( 'audio', 'volume_max', 1 ) ) )
		msg.channel.sendMessage( _.fmt( '`%s` changed volume to `%s`', _.nick( msg.member ), vol ) )
		
		if ( bot )
		{
			const sess = bot.concord_audioSession
			if ( !sess.playing ) return
			
			sess.volume = vol
			sess.encoder.stop()
			start_player( bot, sess.time )
		}
	} })

commands.register( {
	category: 'audio',
	aliases: [ 'title', 'song', 'nowplaying', 'np' ],
	flags: [ 'no_pm' ],
	help: "info about what's currently playing",
	callback: ( client, msg, args ) =>
	{
		const bot = findBot( msg )
		if ( bot )
		{
			const sess = bot.concord_audioSession
			if ( !sess.playing ) return msg.channel.sendMessage( 'nothing is currently playing' )
			
			const song = sess.queue[0]
			if ( !song )
				return msg.channel.sendMessage( 'nothing is currently playing' )
			
			let by_user = get_queuedby_user( song )
			if ( sess.queue.length > 1 )
				by_user += `, +${sess.queue.length - 1} in queue`
			msg.channel.sendMessage( _.fmt( '`NOW PLAYING in %s:\n%s [%s] (%s)`\n<%s>', sess.conn.channel.name, song.title, song.length, by_user, song.url ) )
		}
		else
			msg.channel.sendMessage( 'nothing is currently playing' )
	} })

commands.register( {
	category: 'audio',
	aliases: [ 'queue', 'q' ],
	flags: [ 'no_pm' ],
	help: 'view the current audio queue',
	callback: ( client, msg, args ) =>
	{
		const bot = findBot( msg )
		if ( bot )
		{
			const sess = bot.concord_audioSession
			if ( !sess.playing ) return msg.channel.sendMessage( '```\nempty\n```' )
			
			const queue = sess.queue
			if ( queue.length === 0 )
				return msg.channel.sendMessage( '```\nempty\n```' )
			
			let total_len = 0
			const fields = []
			for ( const i in queue )
			{
				const song = queue[i]
				total_len += parseInt( song.length_seconds )
				const by_user = get_queuedby_user( song )
				fields.push( { name: _.fmt( '%s. %s [%s] (%s)', parseInt(i) + 1, song.title, song.length, by_user ), value: song.url } )
			}
			
			total_len = moment.duration( total_len * 1000 ).format( 'hh:mm:ss' )
			msg.channel.sendMessage( '', false, { title: `${queue.length} songs [${total_len}]`, description: '-', fields } )
		}
		else
			msg.channel.sendMessage( '```\nempty\n```' )
	} })

commands.register( {
	category: 'audio',
	aliases: [ 'pause' ],
	flags: [ 'admin_only', 'no_pm' ],
	help: 'pauses the current song',
	callback: ( client, msg, args ) =>
	{
		const bot = findBot( msg )
		if ( bot )
		{
			const sess = bot.concord_audioSession
			if ( !sess.playing ) return
			if ( sess.paused ) return
			
			sess.paused = true
			sess.encoder.stop()
		}
	} })

commands.register( {
	category: 'audio',
	aliases: [ 'resume' ],
	flags: [ 'admin_only', 'no_pm' ],
	help: 'resumes the current song if paused',
	callback: ( client, msg, args ) =>
	{
		const bot = findBot( msg )
		if ( bot )
		{
			const sess = bot.concord_audioSession
			if ( !sess.playing ) return
			if ( !sess.paused ) return
			
			sess.paused = false
			start_player( bot, sess.time )
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
		const bot = findBot( msg )
		if ( bot )
		{
			const sess = bot.concord_audioSession
			if ( !sess.playing ) return
			
			if ( args )
			{
				sess.encoder.stop()
				start_player( bot, _.parsetime(args) )
			}
			else
			{
				let currentSeek = moment.duration( Math.round(sess.time) * 1000 ).format('hh:mm:ss')
				if ( !currentSeek.match( ':' ) )
					currentSeek = '00:' + currentSeek
	
				msg.channel.sendMessage( _.fmt( 'current seek time: `%s / %s`', currentSeek, sess.queue[0].length ) )
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
		const bot = findBot( msg )
		if ( bot )
		{
			const sess = bot.concord_audioSession
			
			sess.loop = !sess.loop
			if ( sess.loop )
			{
				msg.channel.sendMessage( _.fmt( 'turned on looping, use `%sloop` again to toggle off', settings.get( 'config', 'command_prefix', '!' ) ) )
				if ( sess.lastSong && !sess.playing )
				{
					sess.queue.push( sess.lastSong )
					start_player( bot )
				}
			}
			else
				msg.channel.sendMessage( 'turned off looping, queue will proceed as normal' )
		}
	} })


function sanitize_filename( str )
{
	return str.replace( /[^a-zA-Z0-9-_]/g, '_' ).trim()
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
			return msg.channel.sendMessage( 'please enter a valid playlist name' )
		
		link = link.replace( /</g, '' ).replace( />/g, '' ) // remove filtering
		if ( !is_accepted_url( link ) )
			return msg.channel.sendMessage( _.fmt( '`%s` is not an accepted url', link ) )
		
		const filePath = path.join( __dirname, playlistDir, msg.guild.id + '_' + name + '.json' )
		
		let data = []
		if ( fs.existsSync( filePath ) )
		{
			const playlist = fs.readFileSync( filePath, 'utf8' )
			if ( !_.isjson( playlist ) )
				return msg.channel.sendMessage( 'error in `%s`, please delete', name )
			data = JSON.parse( playlist )
		}
		
		queryRemote( { msg, url: link, returnInfo: true, forPlaylist: true } ).then( info =>
			{
				data.push( info )
				fs.writeFileSync( filePath, JSON.stringify( data, null, 4 ), 'utf8' )
				msg.channel.sendMessage( _.fmt( '`%s` added `%s [%s]` to `%s`', _.nick( msg.member ), info.title, info.length, name ) )
			})
			.catch( s => msg.channel.sendMessage( '```' + s + '```' ) )
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
			
			queryRemote( { quiet: true, msg, url: song.url, returnInfo: true } ).then( info =>
				{
					info.channel = msg.channel
					info.queuedby = msg.member
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
			msg.channel.sendMessage( _.fmt( 'fetching info for `%s` song(s), please wait...', numSongs ) ).then( m =>
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
		const bot = res
		const sess = bot.concord_audioSession

		function do_rest( errors )
		{
			queryMultiple( data, msg, name ).then( res =>
				{
					const queueBuffer = res.queue
					errors += res.errors
	
					const queue_empty = sess.queue.length === 0					
					if ( queue_empty )
						sess.hideNP = true
	
					const verb = queue_empty ? 'started playing' : 'queued'
					const confirmation = _.fmt( '`%s` %s `%s`%s', _.nick( msg.member ), verb, name, errors )
					
					let total_len = 0
					const fields = []
					for ( const i in queueBuffer )
					{
						const song = queueBuffer[i]
						total_len += parseInt( song.length_seconds )
						fields.push( { name: _.fmt( '%s. %s [%s]', parseInt(i) + 1, song.title, song.length ), value: song.url } )
					}
	
					total_len = moment.duration( total_len * 1000 ).format( 'hh:mm:ss' )
					msg.channel.sendMessage( confirmation, false, { title: `${queueBuffer.length} songs [${total_len}]`, description: '-', fields } )
					
					queueBuffer.shift()
					sess.queue.push(...queueBuffer)
					if ( queue_empty )
						start_player( bot )
				})
				.catch( errs =>
				{
					return msg.channel.sendMessage( errs )
				})
		}
		queryRemote( { msg, url: data[0].url, bot: bot } ).then( do_rest('') ).catch( s => do_rest( s+'\n' ) )
	})
	.catch( e => { if ( e.message ) throw e; msg.channel.sendMessage( e ) } )
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
			return msg.channel.sendMessage( 'please enter a valid playlist name' )
		
		const filePath = path.join( __dirname, playlistDir, msg.guild.id + '_' + name + '.json' )
		if ( !fs.existsSync( filePath ) )
			return msg.channel.sendMessage( _.fmt( '`%s` does not exist', name ) )
		
		const playlist = fs.readFileSync( filePath, 'utf8' )
		if ( !_.isjson( playlist ) )
			return msg.channel.sendMessage( 'error in `%s`, please delete', name )
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
					list += file.replace( '.json', '' ).replace( msg.guild.id + '_', '' ) + ', '
				})
			msg.channel.sendMessage( '```--- playlists ---\n' + list.substring( 0, list.length - 2 ) + '```' )
		}
		else
		{
			const name = sanitize_filename( args )
			if ( !name )
				return msg.channel.sendMessage( 'please enter a valid playlist name' )
			
			const filename = msg.guild.id + '_' + name + '.json'
			const filePath = path.join( __dirname, playlistDir, filename )
			
			if ( !fs.existsSync( filePath ) )
				return msg.channel.sendMessage( _.fmt( '`%s` does not exist', name ) )
			
			const playlist = fs.readFileSync( filePath, 'utf8' )
			if ( !_.isjson( playlist ) )
				return msg.channel.sendMessage( 'error in `%s`, please delete', name )
			
			let total_len = 0
			const fields = []
			const data = JSON.parse( playlist )
			for ( const i in data )
			{
				const song = data[i]
				total_len += parseInt( song.length_seconds )
				fields.push( { name: _.fmt( '%s. %s [%s]', parseInt(i) + 1, song.title, song.length ), value: song.url } )
			}
			
			total_len = moment.duration( total_len * 1000 ).format( 'hh:mm:ss' )
			msg.channel.sendMessage( '', false, { title: `${data.length} songs [${total_len}]`, description: '-', fields } )
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
			return msg.channel.sendMessage( 'please enter valid playlist names' )
		
		const oldPath = path.join( __dirname, playlistDir, msg.guild.id + '_' + oldName + '.json' )
		const newPath = path.join( __dirname, playlistDir, msg.guild.id + '_' + newName + '.json' )
		
		if ( !fs.existsSync( oldPath ) )
			return msg.channel.sendMessage( _.fmt( '`%s` does not exist', oldName ) )
		
		if ( fs.existsSync( newPath ) )
			return msg.channel.sendMessage( _.fmt( '`%s` already exists', newName ) )
		
		fs.createReadStream( oldPath ).pipe( fs.createWriteStream( newPath ) )
		msg.channel.sendMessage( _.fmt( '`%s` has been copied to `%s`', oldName, newName ) )
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
			return msg.channel.sendMessage( 'please enter a valid playlist name' )
		
		const filePath = path.join( __dirname, playlistDir, msg.guild.id + '_' + name + '.json' )
		if ( !fs.existsSync( filePath ) )
			return msg.channel.sendMessage( _.fmt( '`%s` does not exist', name ) )
		
		fs.unlinkSync( filePath )
		msg.channel.sendMessage( _.fmt( '`%s` deleted', name ) )
	} })

commands.register( {
	category: 'audio',
	aliases: [ 'audiostats' ],
	help: 'display audio stats for this guild',
	flags: [ 'admin_only', 'no_pm' ],
	callback: ( client, msg, args ) =>
	{
		const gid = msg.guild.id
		if ( !gid in songTracking )
			return msg.channel.sendMessage( 'no audio data found for this server' )

		const sorted = Object.keys( songTracking[ gid ] ).sort(
			(a, b) =>
			{
				return songTracking[ gid ][a].plays < songTracking[ gid ][b].plays ? 1 : 0
			})

		const fields = []
		for ( const url of sorted )
		{
			if ( fields.length > 10 ) break
			const song = songTracking[ gid ][ url ]
			const plays = song.plays
			const title = song.title
			let playtime = song.length_seconds * plays
			playtime = moment.duration( parseInt( playtime ) * 1000 ).format( 'hh:mm:ss' )
			fields.push( { name: `${ fields.length+1 }. ${ title } - ${ plays } plays - ${ playtime } total play time`, value: url } )
		}
		
		msg.channel.sendMessage( '', false, { title: `top 10 songs`, description: '-', fields } )
	} })

var client = null
module.exports.setup = _cl => {
    client = _cl
	_.log( 'loaded plugin: audio' )
	
	initAudio()
	checkSessionActivity()
	songTracking = settings.get( 'songtracking', null, {} )
}

module.exports.songsSinceBoot = 0
