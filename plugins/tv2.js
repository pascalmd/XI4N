"use strict";

var util = require('util'),
	fs = require('fs'),
	path = require('path'),
	kd = require('kdtree.js'),
	stack = require('./tv/stack.js');

var queue = function()
{
	var self = this;

	self.q = new stack();
	self.named = {};

	self.hasNamed = function(name)
	{
		return (self.named[name] !== undefined);
	}

	self.bottom = function()
	{
		return self.q.bottom();
	}

	self.top = function()
	{
		return self.q.top();
	};

	self.push = function(plid, priority, expires, named)
	{
		console.log('pushing %s', named);
		var id = self.q.push(plid, priority, expires);
		if (named)
		{
			self.named[named] = id;
			return named;
		}

		return id;
	};
	
	self.pop = function(id)
	{
		if (id && self.named[id])
			id = self.named[id];
		return self.q.pop(id);
	};

	self.reset = function()
	{
		self.named = {};
		self.q.reset();
	}

	self.all = function()
	{
		return self.q.stack;
	}
}
			
var tvDirector = function()
{
	var self = this;

	self.queue = new queue;

	// vehicle weighting
	self.weighting = {
		'UF1': 0,
		'XFG': 1,
		'XRG': 1,
		'XRT': 2,
		'RB4': 2,
		'FXO': 2,
		'LX4': 2,
		'LX6': 3,
		'MRT': 3,
		'FZ5': 3,
		'XFR': 4,
		'UFR': 4,
		'FOX': 4,
		'FO8': 5,
		'BF1': 7,
		'FXR': 6,
		'XRR': 6,
		'FZR': 6
	};

	self.logger = null;
	self.client = null;
	self.insim = null;
	self.timers = {};
	self.history = {
		'current': 0,
		'previous': 0,
	};

	self.cooldown = 10000;

	var http = require("http");

	http.createServer(function(request, response) {
		response.statusCode = 200;
    	response.setHeader("Content-Type", "text/html");
	    response.write(JSON.stringify(self.queue.all()));
    	response.end();
	}).listen(8081);

	self.init = function()
	{
		this.client.isiFlags |= this.insim.ISF_MCI | this.insim.ISF_CON | this.insim.ISF_HLV | this.insim.ISF_LOCAL;

		this.log.info('Registering TV2');

		self.logger = this.log;
		self.client = this.client;
		self.insim = this.insim;

		self.track = null;

		this.client.on('state:best', self.onFastest);
		this.client.on('state:track', self.onTrack);
		this.client.on('state:race', self.onStart);
		this.client.on('IS_RST', self.onStart);
		this.client.on('IS_LAP', self.onLap);
		this.client.on('IS_PLA', self.onPitLane);
		this.client.on('IS_CON', self.onContact);
		this.client.on('IS_FLG', self.onFlag);
		this.client.on('IS_HLV', self.onInvalidLap);
		this.client.on('IS_FIN', self.onFinish);
		this.client.on('IS_RES', self.onFinalStanding);

		this.client.on('connect', self.onConnect);
		this.client.on('disconnect', self.onDisconnect);
	}

	self.getWeighting = function(vehicle)
	{
		return self.weighting[vehicle];
	}
	
	self.term = function()
	{
		if (self.timer)
			clearTimeout(self.timer);
	}

	self.log = function(text)
	{
		if (!self.logger)
			return;

		self.logger.info('TV2:' + text);
	}

	self.nextViewpoint = function()
	{
		return self.queue.top();
	}

	self.onConnect = function()
	{
		self.timers.next = setInterval(function()
		{
			var d = self.nextViewpoint();
			if (!d || (d.plid <= 0))
			{
				console.log('skipping');	
				return;
			}

			self.log('Changing to ' + d.plid + ' for ' + d.reason);

			self.change(d.plid);
		}, self.cooldown);

		self.timers.hunt = setInterval(function() {
			self.hunt();
		}, self.cooldown);
	}

	self.clearTimers = function()
	{
		for (var i in self.timers)
			clearTimeout(self.timers[i]);
	}

	self.onDisconnect = function()
	{
		self.clearTimers();
	}

	self.onFastest = function()
	{
		var lap = this.client.state.lap;
		var plid = this.client.state.best.plid;

		// we dont care about the fastest laps on lap 1
		if (lap <= 1 || plid <= 0)
			return;

		var score = 1 + (lap * 0.75);
		var ttl = 10;

		self.queue.push({'plid': plid, 'reason': 'new fastest'}, score, ttl);
	}

	self.onTrack = function()
	{
		var track = this.client.state.track;
		if (this.client.state.lname.length > 0)
			track = this.client.state.lname;

		if (track == 'FE2X')
			track = 'F25';

		if (track == 'FE3X')
			track = 'F33';

		if (track == 'AS1X')
			track = 'A11';

		self.track = new kd.KDTree(3);

		console.log('loading pth %s', track);

		var filename = path.join(__dirname, '/../data/pth', track + '.json');
		var pth = JSON.parse(fs.readFileSync(filename, 'utf8'));

		console.log('translating');
		var translated = [];
		for (var i = 0; i < pth.nodes.length; i++)
			translated.push([pth.nodes[i].x, pth.nodes[i].y, pth.nodes[i].z]);

		var start = new Date().getTime();
		console.log('building');
		self.track.build(translated);
		var end = new Date().getTime();
		console.log('building done in %d seconds', (end - start)/1000);
	}

	self.onPitLane = function(pkt)
	{
		if (self.isCurrent(pkt.plid))
			return;

		if (pkt.fact == self.insim.PITLANE_DT)
		{
			self.queue.push({ plid: pkt.plid, reason: 'Serving drive through' }, 100, 5);
			return;
		}

		if (pkt.fact == self.insim.PITLANE_SG)
		{
			self.queue.push({ plid: pkt.plid, reason: 'Serving stop+go through' }, 90, 5);
			return;
		}
	}

	self.onContact = function(pkt)
	{
		//if (self.isCurrent(pkt.a.plid) || self.isCurrent(pkt.b.plid))
	//		return;

		var plid = pkt.a.plid;
		// focus on whoever most likely the cause
		// TODO this is a bit simple	
		if (pkt.b.speed > pkt.a.speed)
			plid = pkt.b.plid;

		if (self.client.state.plyrs[plid].finished)
			return;

		var closingspeed = (pkt.spclose / 10);

		var plyra = this.client.state.getPlyrByPlid(pkt.a.plid);
		var plyrb = this.client.state.getPlyrByPlid(pkt.b.plid);

		var score = 10 + (closingspeed * 0.15) - (self.getWeighting(plyra.cname) - self.getWeighting(plyrb.cname));
		var ttl = 10;

		console.log('Got contact between %s and %s', plyra.pname, plyrb.pname);

		self.queue.push({ 'plid': plid, reason: 'Contact - between' + plyra.pname + ' and ' + plyrb.pname }, score, ttl);
	}

	self.onFlag = function(pkt)
	{
		if (self.isCurrent(pkt.plid))
			return;

		if (!pkt.offon)
			return;

		switch(pkt.flag)
		{
			case self.insim.FLG_BLUE:
				self.log('Blue flag');
				var carbehind = this.client.state.getPlyrByPlid(pkt.carbehind);
				var carinfront = this.client.state.getPlyrByPlid(pkt.plid);
				if (carbehind.speed > carinfront.speed)
				{
					var score = 5 + (self.getWeighting(carbehind.cname) * 0.75) - self.getWeighting(carinfront.cname);
					var ttl = 15;
					self.queue.push({ plid: pkt.carbehind, reason: 'Blue flag, going to overtaker as they are faster'}, score, ttl);
				}
				break;
			case self.insim.FLG_YELLOW:
				var score = 5;
				var ttl = 10;
				self.queue.push({ plid: pkt.plid, reason: 'Yellow flag, going to victim' }, score, ttl);
				break;
		}
	}

	self.onInvalidLap = function(pkt)
	{
		if (self.isCurrent(pkt.plid) || (self.client.state.plyrs[pkt.plid] && self.client.state.plyrs[pkt.plid].finished))
			return;

		var plyr = this.client.state.getPlyrByPlid(pkt.plid);
		if (!plyr.HLVCinfractions)
			plyr.HLVCinfractions = 0;

		switch(pkt.hlvc)
		{
			case self.insim.HLVC_SPEED:
				self.log('HLVC:Speeding');

				plyr.HLVCinfractions++;
				var score = 5 + (plyr.HLVCinfractions * 0.75);
				var ttl = 10;

				self.queue.push({ plid: pkt.plid, reason: 'HLVC: speeding' }, score, ttl);
				break;
			case self.insim.HLVC_WALL:
				self.log('HLVC:Wall');

				plyr.HLVCinfractions++;
				var score = 5 + (plyr.HLVCinfractions * 0.75);
				var ttl = 10;

				self.queue.push({ plid: pkt.plid, reason: 'HLVC: wall' }, score, ttl);
				break;
		}
	}

	self.onStart = function()
	{
		console.log('Got Start');
		self.queue.reset();

		var ctx = this;

		setTimeout(function()
		{
			console.log('startmode callback');
			console.log(ctx.client.state);
			var plyrs = ctx.client.state.plyrs;
			for (var i in plyrs)
			{
				if (!plyrs[i])
					continue;

				console.log('plyrs i=%d, pname=%s, position=%d', i, plyrs[i].pname, plyrs[i].position);
				if (plyrs[i] && (plyrs[i].position == 1))
				{
					var score = 30;
					var ttl = -1;
					console.log('setting startmode plid=%d', plyrs[i].plid);
					self.queue.push({ plid: plyrs[i].plid, reason: 'startmode' }, score, ttl, 'startmode');
					return;
				}
				i++;
			}
		}, 4000);
	}

	self.onLap = function(pkt)
	{
		if (!self.queue.hasNamed('startmode') || (pkt.lapsdone > 0))
			return;

		console.log('removing start mode');

		self.queue.pop('startmode');
	}

	self.onFinish = function(pkt)
	{
		var plyr = this.client.state.getPlyrByPlid(pkt.plid);

		if (plyr.position == 1)
		{
			var score = 20;
			var ttl = 15;
			self.queue.push({ 'name': pkt.plid, reason: 'winner' }, score, ttl);
		}
	}

	self.onFinalStanding = function(pkt)
	{
		// we only care about our winner
		if (pkt.resultnum != 0)
			return;

		// go back to play if nothing else interesting is happening
		//self.queue.push({ plid: pkt.plid, reason: 'final standing' }, 250, 5);
	}

	self.isCurrent = function(plid)
	{
		return (self.history.current === plid);
	}

	self.change = function(plid)
	{
		self.log('change called');
		//if (self.isCurrent(plid))
		//{
	//		console.log('is current, skipping');
//			return;
//		}

		if (!self.insim || !self.client)
		{
			console.log('no insim or client!!');
			return;
		}

		var who = 'unknown player';
		var plyr = self.client.state.getPlyrByPlid(plid);
		if (plyr)
			who = plyr.pname;

		self.history.previous = self.history.current;
		self.history.current = plid;

		var cam = self.insim.VIEW_CAM;
		var rand = Math.random();
		if (rand >= 0.9)
			cam = self.insim.VIEW_DRIVER;

		self.log('Switching to ' + who + ' cam=' + cam);

		var pkt = new self.insim.IS_SCC;
		pkt.viewplid = plid;
		pkt.ingamecam = cam;
		self.client.send(pkt);
	}

	self.hunt = function()
	{
		// hunt for interesting things
		self.log('Hunting');

		var grid = {};
		var plyrs = self.client.state.plyrs;

		for (var i in plyrs)
		{
			var nearest = self.track.nearest([ plyrs[i].x, plyrs[i].y, plyrs[i].z ], 1);
			if (!nearest || nearest.length <= 0)
				continue;

			var node = nearest[0].node;

			if (!grid[node.id])
				grid[node.id] = [];

			grid[node.id].splice(plyrs[i].position, 0, plyrs[i].plid);
		}

		for (var i in grid)
		{
			for (var j = 0; j < grid[i].length; j++)
			{
				if (!grid[i][j])
				{
					grid[i].splice(j, 1);
					i--;
				}
			}
		}

		var maxId = null;
		var maxV = 0;
		for (var i in grid)
		{
			if (grid[i].length > maxV)
			{
				maxV = grid[i].length;
				maxId = i;
			}
		}

		var j = 0;
		var avg = 0;
		for (var i in grid[maxId])
		{
			avg += plyrs[grid[maxId][i]].speed;
			j++;
		}

		if (j <= 0)
			return;

		avg /= j;

		var score = 5 + j + avg;
		var ttl = 20 + (j * 0.5);

		console.log('Score=%d', score);

		var plid = grid[maxId][Math.floor((grid[maxId].length - 1) / 2)];
		self.queue.push({ plid: plid, reason: 'hunted' }, score, ttl);
	}
};

var director = new tvDirector;

exports.init = director.init;
exports.term = director.term;
