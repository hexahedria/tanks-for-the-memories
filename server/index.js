var express = require('express');
var passport = require('passport');
var GoogleStrategy = require('passport-google-oauth').OAuth2Strategy;
var path = require('path');
var S = require('string');
var flash = require('connect-flash');
var fs = require('fs');
var child_process = require('child_process');
var Datastore = require('nedb');
var crypto = require('crypto');
var zmq = require('zmq');

var credentials = require('./credentials');
var config = require('./config');

var app = express();

var userdb = new Datastore({ filename: '../data/usrdb.db', autoload: true });

passport.use(new GoogleStrategy({
    clientID: credentials.GOOGLE_CONSUMER_KEY,
    clientSecret: credentials.GOOGLE_CONSUMER_SECRET,
    callbackURL: config.base_url + '/auth/google/return',
    },
    function(accessToken, refreshToken, profile, done) {
        console.log(profile);
        if(!S(profile.emails[0].value).endsWith('@g.hmc.edu')){
            return done(null, false, { message: 'You need to sign up with a HMC account!'});
        }

        userdb.findOne({ profile_id: profile.id }, function(err, doc){
            if(err)
                return done(err, null);
            if(doc) {
                return done(null, doc);
            } else {
                userdb.insert({
                    profile_id: profile.id,
                    name: profile.displayName,
                    email: profile.emails[0].value,
                    student_id_num_hashed: null,
                }, done);
            }
        });     
    }
));

passport.serializeUser(function(user, done) {
    done(null, user._id);
});

passport.deserializeUser(function(_id, done) {
    userdb.findOne({ _id: _id }, done);
});

var ensureUserLoggedIn = function (req, res, next) {
    if(!req.user){
        res.redirect('/auth/google');
    }else{
        next();
    }
}

var ensureUserSetUp = function (req, res, next) {
    if(!req.user.student_id_num_hashed){
        res.redirect('/account/setup');
    } else {
        next();
    }
};

var ensureUserNotSetUp = function (req, res, next) {
    if(req.user.student_id_num_hashed){
        res.redirect('/');
    } else {
        next();
    }
};


var get_player_status = function(idnum, cb) {
    var statusfile = '../data/' + idnum + '_stat.json';
    fs.stat(statusfile, function (err, stat) {
        if (!err && stat.isFile()){
            fs.readFile(statusfile, function(err, data) {
                if(err) {
                    cb(err, null);
                } else {
                    cb(null, JSON.parse(data));
                }
            });
        } else {
            cb(null, null);
        }
    });
}

var get_player_log = function(idnum, cb) {
    var logfile = '../data/' + idnum + '_out.log';
    fs.stat(logfile, function (err, stat) {
        if (!err && stat.isFile()){
            fs.readFile(logfile, cb);
        } else {
            cb(null, "No log to show.");
        }
    });
}

var clear_player_log = function(idnum, cb) {
    var logfile = '../data/' + idnum + '_out.log';
    fs.stat(logfile, function (err, stat) {
        if (!err && stat.isFile()){
            fs.unlink(logfile, cb);
        } else {
            cb(null);
        }
    });
}

var get_css_color = function(tankcolor) {
    var sc = 255.0/90;
    return 'rgb('+(tankcolor[0]*sc)+','+(tankcolor[1]*sc)+','+(tankcolor[2]*sc)+')';
}

var prepareRender = function (req, res, next) {
    res.locals.errmessages = req.flash('error');
    res.locals.get_css_color = get_css_color;
    if(req.user){
        res.locals.navbar = {
            '/':'Home',
            '/logs':'View Logs',
            '/edit':'Edit Code',
            '/sim':'Simulator',
        }
        res.locals.name = req.user.name;
        res.locals.loggedin = true;
        get_player_status(req.user.student_id_num_hashed, function(err, status){
            if (err) {
                console.log(err);
                res.locals.status = null;
                res.locals.tank_color = "#aaa";
            } else {
                res.locals.status = status;
                if(status == null || !status.alive) {
                    res.locals.tank_color = "#aaa";
                } else {
                    res.locals.tank_color = get_css_color(status.color);
                }
            }
            next();
        });
    } else {
        res.locals.navbar = {
            '/':'Home',
            '/auth/google':'Log in',
        }
        res.locals.name = "not logged in"
        res.locals.loggedin = false;
        res.locals.status = null;
        res.locals.tank_color = "#aaa";
        next();
    }
};


app.use(express.static(path.join(__dirname, 'public')));
app.use(require('cookie-parser')());
app.use(require('body-parser').urlencoded({ extended: true }));
app.use(require('express-session')({ secret: 'safewithme', resave: true, saveUninitialized: true }));
app.use(passport.initialize());
app.use(passport.session());
app.use(flash());
app.use(prepareRender);

app.set('views', './views');
app.set('view engine', 'jade');

app.get('/', function (req, res) {
    // console.log(req.flash('error'));
    get_leaderboard(function(err, leaderboard){
        if (err){
            console.log(err);
            res.status(500).send("Bad!");
            return
        }
        var ids = [];
        for (var i = 0; i < leaderboard.score.length; i++) {
            ids[i] = leaderboard.score[i].id;
            leaderboard.score[i].css_color = get_css_color(leaderboard.score[i].color);
        };
        for (var i = 0; i < leaderboard.survivors.length; i++) {
            leaderboard.survivors[i].css_color = get_css_color(leaderboard.survivors[i].color);
        };
        get_id_to_name_map(ids, function(map){
            if(req.user) {
                get_player_status(req.user.student_id_num_hashed, function(err, status){
                    if (err){
                        console.log(err);
                        res.status(500).send("Bad!");
                        return
                    }
                    res.render('home', {leaderboard:leaderboard, status: status, namemap:map});
                });   
            } else {
                res.render('home', {leaderboard:leaderboard, namemap:map});
            }
        });
        
    });
});

app.get('/auth/google',
    passport.authenticate('google', {scope: 'openid profile email', failureFlash: true}));

app.get('/auth/google/return',
    passport.authenticate('google', { failureRedirect: '/', failureFlash: true }),
    function(req, res) {
        // Successful authentication, redirect home.
        res.redirect('/');
    });

app.get('/logout', function(req, res){
    req.logout();
    res.redirect('/');
});

app.get('/account/setup',
    ensureUserLoggedIn,
    ensureUserNotSetUp,
    function (req, res) {
        res.render('acct_setup')
    }
);
app.post('/account/setup',
    ensureUserLoggedIn,
    ensureUserNotSetUp,
    function (req, res) {
        if(/^\d{8}$/g.test(req.body.idnum)){
            userdb.findOne({ student_id_num_hashed: req.body.idnum }, function(err, doc){
                if(err){
                    console.log(err);
                    res.status(500).send("Bad!");
                    return
                }
                if(doc) {
                    // User with this id number already exists!
                    req.flash('error', 'Someone else already registered that ID number!');
                    res.redirect('/account/setup');
                } else {
                    var shasum = crypto.createHash('sha512');
                    shasum.update(req.body.idnum);
                    var hashed_idnum = shasum.digest('hex');
                    userdb.update({ _id: req.user._id }, {$set:{ student_id_num_hashed: hashed_idnum }},
                    function(err, numReplaced, newDoc){
                        if(err){
                            console.log(err);
                            res.status(500).send("Bad!");
                            return
                        }
                        req.user = newDoc;

                        // Copy default file
                        var default_file = '../game/ais/tank_template.py';
                        var aifile = '../data/' + hashed_idnum + '.py';
                        var content = fs.readFileSync(default_file);
                        fs.writeFileSync(aifile, content);

                        res.redirect('/');
                    });
                }
            });
        } else {
            // Bad ID number
            res.redirect('/account/setup');
        }
    }
);

app.get('/logs',
    ensureUserLoggedIn,
    ensureUserSetUp,
    function (req, res) {
        get_player_log(req.user.student_id_num_hashed, function(err, log){
            if (err){
                console.log(err);
                res.status(500).send("Bad!");
                return
            }
            res.render('logs', {log:log});
        });
    }
);

app.post('/logs/clear',
    ensureUserLoggedIn,
    ensureUserSetUp,
    function (req, res) {
        clear_player_log(req.user.student_id_num_hashed, function(err){
            if (err){
                console.log(err);
                res.status(500).send("Bad!");
                return
            }
            res.send('OK');
        });
    }
);

var get_aifile_contents = function(idnum, cb) {
    var aifile = '../data/' + idnum + '.py';
    fs.readFile(aifile, cb);
}

app.get('/edit',
    ensureUserLoggedIn,
    ensureUserSetUp,
    function (req, res) {
        get_aifile_contents(req.user.student_id_num_hashed, function(err, contents){
            if (err){
                console.log(err);
                res.status(500).send("Bad!");
                return
            }
            res.render('edit', {initialcontents: contents});
        });
    }
);
app.post('/edit',
    ensureUserLoggedIn,
    ensureUserSetUp,
    function (req, res) {
        var aifile = '../data/' + req.user.student_id_num_hashed + '.py';
        fs.writeFile(aifile, req.body.value);
        child_process.execFile('python',['../game/test-compile.py', aifile],{},function(err,stdout,stderr){
            if (err) throw err;
            res.send(stdout);
        });
    }
);

app.get('/sim',
    ensureUserLoggedIn,
    ensureUserSetUp,
    function (req, res) {
        get_aifile_contents(req.user.student_id_num_hashed, function(err, usercode){
            if (err){
                console.log(err);
                res.status(500).send("Bad!");
                return
            }
            get_aifile_contents('../game/ais/wall_hugger', function(err, enemycode){
                if (err){
                    console.log(err);
                    res.status(500).send("Bad!");
                    return
                }
                res.render('sim', {usercode: usercode, enemycode: enemycode});
            });
        });
    }
);

var get_leaderboard = function(cb) {
    var logfile = '../data/leaderboard.json';
    fs.readFile(logfile, function(err, data) {
        if(err) {
            cb(err, null);
        } else {
            cb(null, JSON.parse(data));
        }
    });
}

var get_id_to_name_map = function(ids, cb){
    var id_to_name_map = {};
    var num_left = ids.length;
    function do_find(cur_id){
        userdb.findOne({ student_id_num_hashed: cur_id }, function(err, doc){
            if(err){
                console.log(err);
                id_to_name_map[cur_id] = "Error finding!";
            } else if(doc) {
                id_to_name_map[cur_id] = doc.name;
            } else {
                id_to_name_map[cur_id] = cur_id + " (non-player tank)";
            }
            num_left--;
            if(num_left == 0){
                cb(id_to_name_map);
            }
        });
    }
    if(num_left == 0) {
        cb({});
        return;
    }
    for (var i = 0; i < ids.length; i++) {
        do_find(ids[i]);
    };
}

var server = app.listen(config.listen_port, function () {
    var host = server.address().address;
    var port = server.address().port;

    console.log('Example app listening at http://%s:%s', host, port);
});

sock = zmq.socket('rep');
sock.on('message', function(a){
    evt = JSON.parse(a.toString());
    if(evt[0] == "death"){
        console.log(evt[1],'killed',evt[2]);
    }
    sock.send("OK");
});

sock.bind('tcp://*:' + config.zmq_port, function(){
    console.log('Responder bound to port ' + config.zmq_port);
});
